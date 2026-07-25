import { Injectable, Inject, NotFoundException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Appointment } from '@domain/appointment/appointment.entity';
import { RecurringBlock } from '@domain/availability/recurring-block.entity';
import { RECURRING_BLOCK_REPOSITORY, RecurringBlockRepository } from '@domain-services/availability/recurring-block.repository';
import { AppointmentRepository, APPOINTMENT_REPOSITORY } from '@domain-services/patient-ops/appointment.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { TenantContext } from '@shared/tenant-context';
import { VerificarDisponibilidadeUseCase } from '@use-cases/availability/verificar-disponibilidade.use-case';

export interface MaterializarRecurringBlockInput {
  recurringBlockId: string;
  /** Janela de materialização — limitada, configurável, determinística (decisão arquitetural C3). Nunca "todo o futuro" numa chamada. */
  from: Date;
  to: Date;
}

export type OcorrenciaPuladaMotivo = 'already_materialized' | 'not_available';

export interface MaterializarRecurringBlockResult {
  created: Appointment[];
  skipped: Array<{ scheduledAt: Date; reason: OcorrenciaPuladaMotivo }>;
}

/**
 * MaterializarRecurringBlockUseCase — PD-001 Fase 2, C3. Transforma um
 * `RecurringBlock` (padrão abstrato) em `Appointment`s reais, dentro de uma
 * janela temporal limitada. Sequência arquitetural obrigatória (registrada
 * na revisão da C3): RecurringBlock → geração de candidatas → verificação
 * de idempotência → Motor de Disponibilidade → saveMany(). Nenhuma outra
 * ordem é aceita.
 *
 * NÃO consulta `ClinicHoliday`/`AvailabilityException`/`AvailabilityWindow`
 * diretamente — são resolvidos inteiramente dentro de
 * `VerificarDisponibilidadeUseCase` (o Motor), a única integração
 * explícita permitida (decisão registrada em C1).
 *
 * Job-safety (nota honesta, não escondida): este Caso de Uso usa
 * `TenantContext`, assim como `CriarAgendamentoRecorrenteUseCase`/
 * `DefinirDisponibilidadeUseCase` já fazem — não é, por si só,
 * independente de contexto de requisição HTTP. Diferente de
 * `RecurringBlockRepository` (explicitamente "job-safe", tenantId
 * explícito), `AppointmentRepository` (`PrismaService.forTenant()`) e
 * `VerificarDisponibilidadeUseCase` dependem de `TenantContext` já
 * populado — uma limitação real herdada dos contratos existentes, não
 * introduzida aqui. Um futuro job/scheduler (fora do escopo da C3) precisa
 * popular `TenantContext` por Tenant antes de chamar este Caso de Uso.
 */
@Injectable()
export class MaterializarRecurringBlockUseCase {
  constructor(
    @Inject(RECURRING_BLOCK_REPOSITORY) private readonly recurringBlockRepo: RecurringBlockRepository,
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointmentRepo: AppointmentRepository,
    private readonly verificarDisponibilidade: VerificarDisponibilidadeUseCase,
    private readonly tenantContext: TenantContext,
    private readonly auditService: AuditService,
  ) {}

  async execute(input: MaterializarRecurringBlockInput): Promise<MaterializarRecurringBlockResult> {
    if (input.from >= input.to) {
      throw new Error(`Janela de materialização inválida: from deve ser anterior a to (${input.from.toISOString()}-${input.to.toISOString()}).`);
    }

    const block = await this.recurringBlockRepo.findById(this.tenantContext.tenantId, input.recurringBlockId);
    if (!block) {
      throw new NotFoundException('RecurringBlock não encontrado.');
    }

    const skipped: MaterializarRecurringBlockResult['skipped'] = [];
    const toCreate: Appointment[] = [];

    for (const scheduledAt of this.candidateDatesWithin(block, input.from, input.to)) {
      const alreadyExists = await this.appointmentRepo.existsForRecurringBlockOccurrence(block.id, scheduledAt);
      if (alreadyExists) {
        skipped.push({ scheduledAt, reason: 'already_materialized' });
        continue;
      }

      const disponivel = await this.verificarDisponibilidade.execute({
        therapistId: block.therapistId,
        scheduledAt,
      });
      if (!disponivel) {
        skipped.push({ scheduledAt, reason: 'not_available' });
        continue;
      }

      const appointment = Appointment.create({
        id: randomUUID(),
        tenantId: this.tenantContext.tenantId,
        patientId: block.patientId,
        therapistId: block.therapistId,
        scheduledAt,
        modality: block.modality,
        recurring: true,
        recurringBlockId: block.id,
      });
      appointment.transitionTo('Reservada');
      toCreate.push(appointment);
    }

    const { created, racedAway } = await this.saveWithRetryOnRace(toCreate);
    for (const appointment of racedAway) {
      skipped.push({ scheduledAt: appointment.scheduledAt, reason: 'already_materialized' });
    }
    for (const appointment of created) {
      await this.auditService.recordAll(appointment.pullDomainEvents());
    }

    return { created, skipped };
  }

  private candidateDatesWithin(block: RecurringBlock, from: Date, to: Date): Date[] {
    const dates: Date[] = [];
    let candidate = block.firstOccurrence;
    const stepMs = block.intervalDays * 24 * 60 * 60 * 1000;
    while (candidate < from) {
      candidate = new Date(candidate.getTime() + stepMs);
    }
    while (candidate < to) {
      dates.push(candidate);
      candidate = new Date(candidate.getTime() + stepMs);
    }
    return dates;
  }

  /**
   * Corrida de concorrência (decisão arquitetural C3, registrada): captura
   * especificamente SESSION_CONFLICT de `saveMany()`, revalida SOMENTE as
   * ocorrências deste lote — as que já existem são sucesso idempotente
   * (outra execução chegou primeiro), as que ainda não existem recebem um
   * ÚNICO retry. Sem loop: se o retry falhar de novo, propaga — deixou de
   * ser idempotência, é um conflito real que não deve ser mascarado.
   */
  private async saveWithRetryOnRace(
    appointments: Appointment[],
  ): Promise<{ created: Appointment[]; racedAway: Appointment[] }> {
    if (appointments.length === 0) {
      return { created: [], racedAway: [] };
    }
    try {
      await this.appointmentRepo.saveMany(appointments);
      return { created: appointments, racedAway: [] };
    } catch (err) {
      if (!this.isSessionConflict(err)) {
        throw err;
      }

      const stillMissing: Appointment[] = [];
      const racedAway: Appointment[] = [];
      for (const appointment of appointments) {
        const exists = await this.appointmentRepo.existsForRecurringBlockOccurrence(
          appointment.recurringBlockId as string,
          appointment.scheduledAt,
        );
        if (exists) {
          racedAway.push(appointment);
        } else {
          stillMissing.push(appointment);
        }
      }
      if (stillMissing.length > 0) {
        await this.appointmentRepo.saveMany(stillMissing); // retry único — se falhar aqui, propaga
      }
      return { created: stillMissing, racedAway };
    }
  }

  private isSessionConflict(err: unknown): boolean {
    return err instanceof ConflictException && (err.getResponse() as { code?: string })?.code === 'SESSION_CONFLICT';
  }
}
