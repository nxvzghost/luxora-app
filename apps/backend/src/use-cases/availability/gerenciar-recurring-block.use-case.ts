import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RecurringBlock } from '@domain/availability/recurring-block.entity';
import { RECURRING_BLOCK_REPOSITORY, RecurringBlockRepository } from '@domain-services/availability/recurring-block.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { TenantContext } from '@shared/tenant-context';
import { PatientRepository, PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { TherapistRepository, THERAPIST_REPOSITORY } from '@domain-services/platform/therapist.repository';

/**
 * CriarRecurringBlockUseCase — PD-001 Fase 2, C4.1. Primeiro Caso de Uso de
 * escrita de `RecurringBlock` — nasce já com auditoria integrada (mesmo
 * padrão consolidado na revisão da B5, aplicado desde o início desta vez,
 * sem o gap que a ClinicHoliday teve). `tenantId` obtido de `TenantContext`
 * aqui, na camada de aplicação (permitido; a restrição de nunca depender de
 * contexto implícito é do Repository, não do Caso de Uso).
 *
 * Escopo deliberadamente restrito: não consulta o Motor de Disponibilidade
 * (criar o padrão não é agendar uma ocorrência — isso é responsabilidade de
 * MaterializarRecurringBlockUseCase, C3, que não é acionado automaticamente
 * aqui), não aciona materialização, não expõe remoção/cancelamento (sem
 * decisão de produto aprovada sobre pausa/cancelamento de ocorrências já
 * materializadas).
 */
export interface CriarRecurringBlockInput {
  patientId: string;
  therapistId: string;
  firstOccurrence: Date;
  intervalDays: number;
  modality: 'presencial' | 'online';
  renewalMode: 'automatic' | 'manual';
}

@Injectable()
export class CriarRecurringBlockUseCase {
  constructor(
    @Inject(RECURRING_BLOCK_REPOSITORY) private readonly repo: RecurringBlockRepository,
    private readonly tenantContext: TenantContext,
    private readonly auditService: AuditService,
    @Inject(PATIENT_REPOSITORY) private readonly patientRepo: PatientRepository,
    @Inject(THERAPIST_REPOSITORY) private readonly therapistRepo: TherapistRepository,
  ) {}

  async execute(input: CriarRecurringBlockInput): Promise<RecurringBlock> {
    // Tarefa 06 (AD-032) — ACHADO REAL: nem paciente nem terapeuta eram
    // conferidos, e as chaves estrangeiras não olham a clínica: o horário
    // fixo era gravado nesta clínica apontando para paciente ou terapeuta
    // de outra. As duas leituras passam pela RLS.
    if (!(await this.patientRepo.findById(input.patientId))) {
      throw new NotFoundException('Paciente não encontrado.');
    }
    if (!(await this.therapistRepo.findById(input.therapistId))) {
      throw new NotFoundException('Terapeuta não encontrado.');
    }

    const block = RecurringBlock.create({
      id: randomUUID(),
      tenantId: this.tenantContext.tenantId,
      patientId: input.patientId,
      therapistId: input.therapistId,
      firstOccurrence: input.firstOccurrence,
      intervalDays: input.intervalDays,
      modality: input.modality,
      renewalMode: input.renewalMode,
    });
    block.markCreated();
    await this.repo.save(block);
    await this.auditService.recordAll(block.pullDomainEvents());
    return block;
  }
}

/**
 * ListarRecurringBlocksUseCase — PD-001 Fase 2, C4.2. Consulta pura, sem
 * efeito colateral — não audita, mesma regra já usada por
 * `ListarFeriadosUseCase`/`ConsultarCalendarioUseCase` (nenhum Caso de Uso
 * somente-leitura deste projeto chama `AuditService`).
 */
@Injectable()
export class ListarRecurringBlocksUseCase {
  constructor(
    @Inject(RECURRING_BLOCK_REPOSITORY) private readonly repo: RecurringBlockRepository,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(therapistId: string): Promise<RecurringBlock[]> {
    return this.repo.findByTenantAndTherapist(this.tenantContext.tenantId, therapistId);
  }
}
