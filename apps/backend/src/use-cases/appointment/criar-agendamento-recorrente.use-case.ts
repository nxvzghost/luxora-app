import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Appointment } from '@domain/appointment/appointment.entity';
import {
  AppointmentRepository,
  APPOINTMENT_REPOSITORY,
} from '@domain-services/patient-ops/appointment.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { TenantContext } from '@shared/tenant-context';

export interface CriarAgendamentoRecorrenteInput {
  patientId: string;
  therapistId: string;
  firstScheduledAt: Date;
  modality: 'presencial' | 'online';
  occurrences: number; // nº de sessões a criar, incluindo a primeira
  intervalDays: number; // 7 = semanal, 14 = quinzenal
}

/**
 * CriarAgendamentoRecorrenteUseCase — RF-059, JP-010.
 *
 * Escopo deliberadamente reduzido neste módulo: cria N ocorrências em
 * intervalo fixo, sem ajuste automático para feriados/férias/bloqueios
 * (mencionado no PRD original) — essa parte fica registrada como dívida
 * explícita (ver README do módulo), não implementada silenciosamente pela
 * metade.
 *
 * LIMITAÇÃO CONHECIDA (registrada, não escondida): se a ocorrência N de um
 * lote colidir com um agendamento já existente (SESSION_CONFLICT), as
 * ocorrências 1..N-1 já salvas NÃO são revertidas automaticamente — o
 * Repository ainda não expõe uma transação abrangendo múltiplas linhas de
 * Appointment. Resultado possível hoje: recorrência "pela metade" no
 * banco, com a exceção subindo para o cliente saber que algo falhou.
 * Correção real (envolver o laço inteiro em uma única transação Prisma)
 * fica para quando o Repository ganhar um método `saveMany` transacional —
 * dívida explícita, não interrompe a entrega deste módulo porque o cenário
 * de colisão em agendamento recorrente é raro (checagem de disponibilidade
 * já deveria ter acontecido antes, via ConsultarDisponibilidade).
 */
@Injectable()
export class CriarAgendamentoRecorrenteUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository,
    private readonly tenantContext: TenantContext,
    private readonly auditService: AuditService,
  ) {}

  async execute(input: CriarAgendamentoRecorrenteInput): Promise<Appointment[]> {
    if (input.occurrences < 1) {
      throw new Error('occurrences deve ser ao menos 1.');
    }

    const created: Appointment[] = [];
    for (let i = 0; i < input.occurrences; i++) {
      const scheduledAt = new Date(
        input.firstScheduledAt.getTime() + i * input.intervalDays * 24 * 60 * 60 * 1000,
      );
      const appointment = Appointment.create({
        id: randomUUID(),
        tenantId: this.tenantContext.tenantId,
        patientId: input.patientId,
        therapistId: input.therapistId,
        scheduledAt,
        modality: input.modality,
        recurring: true,
      });
      appointment.transitionTo('Reservada');
      await this.repo.save(appointment);
      await this.auditService.recordAll(appointment.pullDomainEvents()); // retrofit da revisão geral
      created.push(appointment);
    }
    return created;
  }
}
