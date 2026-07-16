import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Appointment } from '@domain/appointment/appointment.entity';
import {
  AppointmentRepository,
  APPOINTMENT_REPOSITORY,
} from '@domain-services/patient-ops/appointment.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { TenantContext } from '@shared/tenant-context';

export interface AgendarConsultaInput {
  patientId: string;
  therapistId: string;
  scheduledAt: Date;
  modality: 'presencial' | 'online';
  recurring?: boolean;
}

/**
 * AgendarConsultaUseCase — RF-051.
 *
 * A defesa contra conflito de agenda concorrente (Teste Crítico #10) NÃO
 * vive aqui — vive no índice único parcial do banco
 * (prisma/rls/unique-active-appointment.sql, ADR-0028). Este Caso de Uso
 * apenas cria e salva; se dois clientes tentarem agendar o mesmo horário
 * ao mesmo tempo, o segundo `save()` lança ConflictException(SESSION_CONFLICT)
 * — a corrida é resolvida no banco, nunca em memória.
 */
@Injectable()
export class AgendarConsultaUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository,
    private readonly auditService: AuditService,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(input: AgendarConsultaInput): Promise<Appointment> {
    const appointment = Appointment.create({
      id: randomUUID(),
      tenantId: this.tenantContext.tenantId,
      patientId: input.patientId,
      therapistId: input.therapistId,
      scheduledAt: input.scheduledAt,
      modality: input.modality,
      recurring: input.recurring ?? false,
    });

    appointment.transitionTo('Reservada');
    await this.repo.save(appointment); // pode lançar SESSION_CONFLICT — ver nota acima
    await this.auditService.recordAll(appointment.pullDomainEvents()); // Módulo 10
    return appointment;
  }
}
