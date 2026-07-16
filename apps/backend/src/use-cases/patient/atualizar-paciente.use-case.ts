import { Injectable, Inject } from '@nestjs/common';
import { Patient } from '@domain/patient/patient.entity';
import { PatientRepository, PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { DomainEvent } from '@domain/shared/domain-event';
import { ConsultarPacienteUseCase } from './consultar-paciente.use-case';

export interface AtualizarPacienteInput {
  id: string;
  name?: string;
  phone?: string;
  billingPolicyOverride?: 'per_session' | 'weekly' | 'monthly' | null;
}

/**
 * GAP ENCONTRADO NESTA REVISÃO GERAL: Patient só emite DomainEvent em
 * transitionTo() — uma atualização de dado puro (nome, telefone,
 * billingPolicyOverride) nunca gerava evento nenhum, então nunca havia
 * nada para o retrofit de auditoria (Módulo 10) persistir aqui. Mudar
 * billingPolicyOverride é sensível o bastante (afeta cobrança) para
 * merecer registro — criado um evento ad-hoc para isso, mesmo padrão já
 * usado para AiInteractionAuditEvent (Módulo 12).
 */
class PatientDataUpdatedEvent extends DomainEvent {
  constructor(
    entityId: string,
    tenantId: string,
    readonly changedFields: string[],
  ) {
    super('PacienteDadosAtualizados', entityId, tenantId);
  }
}

/**
 * AtualizarPacienteUseCase — RF-026 a RF-039.
 *
 * A alteração de billingPolicyOverride é o caso mais sensível deste Caso de
 * Uso: reflete diretamente a regra de "cobrança por paciente, não por
 * clínica" já corrigida no Módulo 05 anterior à implementação.
 */
@Injectable()
export class AtualizarPacienteUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY) private readonly patientRepository: PatientRepository,
    private readonly consultarPaciente: ConsultarPacienteUseCase,
    private readonly auditService: AuditService,
  ) {}

  async execute(input: AtualizarPacienteInput): Promise<Patient> {
    const patient = await this.consultarPaciente.execute(input.id);

    // A entidade de Domain hoje não expõe setters para name/phone/billingPolicy
    // (imutáveis por design fora do construtor) — reconstituímos com os
    // valores atualizados, preservando o estado e o id. Dívida registrada.
    const updated = Patient.reconstitute({
      id: patient.id,
      tenantId: patient.tenantId,
      name: input.name?.trim() || patient.name,
      phone: input.phone || patient.phone,
      state: patient.state,
      billingPolicyOverride:
        input.billingPolicyOverride === null
          ? undefined
          : input.billingPolicyOverride ?? patient.billingPolicyOverride,
    });

    await this.patientRepository.save(updated);

    const changedFields = Object.keys(input).filter((k) => k !== 'id');
    if (changedFields.length > 0) {
      await this.auditService.recordAll([
        new PatientDataUpdatedEvent(updated.id, updated.tenantId, changedFields),
      ]);
    }

    return updated;
  }
}
