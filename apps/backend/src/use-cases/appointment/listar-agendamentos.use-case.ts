import { Injectable, Inject } from '@nestjs/common';
import { Appointment } from '@domain/appointment/appointment.entity';
import { AppointmentRepository, APPOINTMENT_REPOSITORY } from '@domain-services/patient-ops/appointment.repository';

@Injectable()
export class ListarAgendamentosUseCase {
  constructor(@Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository) {}

  async execute(from: Date, to: Date): Promise<Appointment[]> {
    return this.repo.findByTenantAndRange(from, to);
  }
}
