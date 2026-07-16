import { Injectable, Inject } from '@nestjs/common';
import { Patient } from '@domain/patient/patient.entity';
import { PatientRepository, PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { ConsultarPacienteUseCase } from './consultar-paciente.use-case';

@Injectable()
export class InativarPacienteUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY) private readonly patientRepository: PatientRepository,
    private readonly consultarPaciente: ConsultarPacienteUseCase,
    private readonly auditService: AuditService,
  ) {}

  async execute(id: string): Promise<Patient> {
    const patient = await this.consultarPaciente.execute(id);
    patient.transitionTo('Inativo');
    await this.patientRepository.save(patient);
    await this.auditService.recordAll(patient.pullDomainEvents()); // Módulo 10, retrofit completo
    return patient;
  }
}

@Injectable()
export class ReativarPacienteUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY) private readonly patientRepository: PatientRepository,
    private readonly consultarPaciente: ConsultarPacienteUseCase,
    private readonly auditService: AuditService,
  ) {}

  async execute(id: string): Promise<Patient> {
    const patient = await this.consultarPaciente.execute(id);
    patient.transitionTo('Ativo'); // JP-013
    await this.patientRepository.save(patient);
    await this.auditService.recordAll(patient.pullDomainEvents());
    return patient;
  }
}

@Injectable()
export class DarAltaPacienteUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY) private readonly patientRepository: PatientRepository,
    private readonly consultarPaciente: ConsultarPacienteUseCase,
    private readonly auditService: AuditService,
  ) {}

  async execute(id: string): Promise<Patient> {
    const patient = await this.consultarPaciente.execute(id);
    patient.transitionTo('Alta'); // JP-014
    await this.patientRepository.save(patient);
    await this.auditService.recordAll(patient.pullDomainEvents());
    return patient;
  }
}
