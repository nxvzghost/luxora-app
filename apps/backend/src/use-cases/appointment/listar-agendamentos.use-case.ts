import { Injectable, Inject } from '@nestjs/common';
import { Appointment } from '@domain/appointment/appointment.entity';
import { AppointmentOutcomeRecord } from '@domain/appointment/appointment-outcome';
import { AppointmentRepository, APPOINTMENT_REPOSITORY } from '@domain-services/patient-ops/appointment.repository';
import {
  AppointmentOutcomeRepository,
  APPOINTMENT_OUTCOME_REPOSITORY,
} from '@domain-services/patient-ops/appointment-outcome.repository';

export interface AppointmentWithOutcome {
  appointment: Appointment;
  /** K2-b — o desfecho registrado, se houver (realização, falta, abono). */
  outcome: AppointmentOutcomeRecord | null;
}

@Injectable()
export class ListarAgendamentosUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository,
    @Inject(APPOINTMENT_OUTCOME_REPOSITORY) private readonly outcomes: AppointmentOutcomeRepository,
  ) {}

  async execute(from: Date, to: Date): Promise<AppointmentWithOutcome[]> {
    const appointments = await this.repo.findByTenantAndRange(from, to);
    const outcomes = await this.outcomes.findByAppointmentIds(appointments.map((appointment) => appointment.id));
    return appointments.map((appointment) => ({ appointment, outcome: outcomes.get(appointment.id) ?? null }));
  }
}
