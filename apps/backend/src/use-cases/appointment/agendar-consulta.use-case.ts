import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Appointment } from '@domain/appointment/appointment.entity';
import {
  AppointmentRepository,
  APPOINTMENT_REPOSITORY,
} from '@domain-services/patient-ops/appointment.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { TenantContext } from '@shared/tenant-context';
import { VerificarDisponibilidadeUseCase } from '@use-cases/availability/verificar-disponibilidade.use-case';
import { SlotNotAvailableError } from '@domain-services/availability/slot-not-available.error';

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
 * ADR-0040 (PD-001): consulta o Motor de Disponibilidade ANTES de criar o
 * Appointment — violação confirmada na análise arquitetural, corrigida
 * aqui. A garantia vive neste Caso de Uso, não em cada chamador — qualquer
 * caminho que chegue até aqui (Controller HTTP, IntentActionRouter da IA)
 * herda a proteção automaticamente, por construção.
 *
 * A defesa contra conflito de agenda concorrente (Teste Crítico #10) além
 * disso NÃO vive só aqui — vive também no índice único parcial do banco
 * (prisma/rls/unique-active-appointment.sql, ADR-0028), como segunda camada:
 * se dois clientes tentarem agendar o mesmo horário exatamente ao mesmo
 * tempo, o segundo `save()` ainda pode lançar ConflictException(SESSION_CONFLICT).
 */
@Injectable()
export class AgendarConsultaUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository,
    private readonly verificarDisponibilidade: VerificarDisponibilidadeUseCase,
    private readonly auditService: AuditService,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(input: AgendarConsultaInput): Promise<Appointment> {
    const disponivel = await this.verificarDisponibilidade.execute({
      therapistId: input.therapistId,
      scheduledAt: input.scheduledAt,
    });
    if (!disponivel) {
      throw new SlotNotAvailableError();
    }

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
