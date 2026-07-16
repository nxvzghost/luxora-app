import { Injectable, Inject } from '@nestjs/common';
import { Patient } from '@domain/patient/patient.entity';
import { PatientRepository, PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';

export interface ListarPacientesInput {
  cursor?: string;
  limit?: number;
}

@Injectable()
export class ListarPacientesUseCase {
  constructor(@Inject(PATIENT_REPOSITORY) private readonly patientRepository: PatientRepository) {}

  async execute(input: ListarPacientesInput): Promise<Patient[]> {
    return this.patientRepository.findAllByTenant(input);
  }
}
