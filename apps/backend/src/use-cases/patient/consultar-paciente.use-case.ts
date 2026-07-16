import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Patient } from '@domain/patient/patient.entity';
import { PatientRepository, PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';

@Injectable()
export class ConsultarPacienteUseCase {
  constructor(@Inject(PATIENT_REPOSITORY) private readonly patientRepository: PatientRepository) {}

  async execute(id: string): Promise<Patient> {
    const patient = await this.patientRepository.findById(id);
    if (!patient) {
      // 404 genérico — nunca revelar se o paciente existe em outro Tenant
      // (o filtro de tenant já aconteceu dentro do Repository via
      // PrismaService.forTenant(), então "não encontrado" cobre os dois
      // casos: não existe, ou existe em outro Tenant).
      throw new NotFoundException('Paciente não encontrado.');
    }
    return patient;
  }
}
