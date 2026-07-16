import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Appointment } from '@domain/appointment/appointment.entity';
import {
  AppointmentRepository,
  APPOINTMENT_REPOSITORY,
} from '@domain-services/patient-ops/appointment.repository';
import { AuditService } from '@domain-services/platform/audit.service';

async function findOrThrow(repo: AppointmentRepository, id: string): Promise<Appointment> {
  const appointment = await repo.findById(id);
  if (!appointment) {
    throw new NotFoundException('Agendamento não encontrado.');
  }
  return appointment;
}

/**
 * RemarcarConsultaUseCase — RF-052.
 */
@Injectable()
export class RemarcarConsultaUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository,
    private readonly auditService: AuditService,
  ) {}

  async execute(id: string, newScheduledAt: Date): Promise<Appointment> {
    const appointment = await findOrThrow(this.repo, id);
    appointment.transitionTo('ReagendamentoSolicitado');
    appointment.reschedule(newScheduledAt);
    await this.repo.save(appointment);
    await this.auditService.recordAll(appointment.pullDomainEvents());
    return appointment;
  }
}

/** CancelarConsultaUseCase — RF-053. */
@Injectable()
export class CancelarConsultaUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository,
    private readonly auditService: AuditService,
  ) {}

  async execute(id: string): Promise<Appointment> {
    const appointment = await findOrThrow(this.repo, id);
    appointment.transitionTo('Cancelada');
    await this.repo.save(appointment);
    await this.auditService.recordAll(appointment.pullDomainEvents());
    return appointment;
  }
}

/** ConfirmarConsultaUseCase — RF-054, RN e JP-004. */
@Injectable()
export class ConfirmarConsultaUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository,
    private readonly auditService: AuditService,
  ) {}

  async execute(id: string): Promise<Appointment> {
    const appointment = await findOrThrow(this.repo, id);
    appointment.transitionTo('Confirmada');
    await this.repo.save(appointment);
    await this.auditService.recordAll(appointment.pullDomainEvents());
    return appointment;
  }
}
