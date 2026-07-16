import { Injectable, Inject, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Patient } from '@domain/patient/patient.entity';
import { PatientRepository, PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { TenantContext } from '@shared/tenant-context';

export interface CadastrarPacienteInput {
  name: string;
  phone: string;
}

/**
 * CadastrarPacienteUseCase — RF-026 a RF-039.
 * Cria o Paciente no estado Novo e já avança para Identificado + Cadastrado
 * (o cadastro em si já fornece nome e telefone, então os dois primeiros
 * estados são percorridos na mesma operação — não há um "meio-cadastro"
 * intermediário no fluxo real de UX).
 */
@Injectable()
export class CadastrarPacienteUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY) private readonly patientRepository: PatientRepository,
    private readonly auditService: AuditService,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(input: CadastrarPacienteInput): Promise<Patient> {
    if (!input.name.trim()) {
      throw new ConflictException('Nome do paciente é obrigatório.');
    }

    const patient = Patient.create({
      id: randomUUID(),
      tenantId: this.tenantContext.tenantId,
      name: input.name.trim(),
      phone: input.phone,
    });

    patient.transitionTo('Identificado');
    patient.transitionTo('Cadastrado');

    await this.patientRepository.save(patient);

    // Módulo 10: eventos agora persistidos de verdade, não mais descartados.
    await this.auditService.recordAll(patient.pullDomainEvents());

    return patient;
  }
}
