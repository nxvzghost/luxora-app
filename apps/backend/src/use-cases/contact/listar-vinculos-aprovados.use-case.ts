import { Injectable, Inject } from '@nestjs/common';
import { ContactRepository, CONTACT_REPOSITORY } from '@domain-services/patient-ops/contact.repository';
import { PatientRepository, PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';

const MAX_LINKED_CONTACTS = 100;

export interface LinkedContact {
  contactId: string;
  phoneNumber: string;
  patientId: string;
  patientName: string;
  /** Quando o vínculo foi criado (a aprovação). */
  linkedAt: Date;
}

/**
 * ListarVinculosAprovadosUseCase — A-10 da auditoria (19/10/2026). Os
 * números que identificam um paciente porque a clínica aprovou o vínculo: é
 * a lista de onde o administrador desfaz um vínculo aprovado por engano.
 *
 * Fica de fora o número que consta no cadastro do próprio paciente (o
 * reconhecimento pelo cadastro, ou o paciente cadastrado pelo WhatsApp):
 * esse não depende de vínculo, e desfazer não mudaria nada. Para ele, quem
 * manda é o telefone do cadastro.
 *
 * No máximo 100 contatos, os de atividade mais recente primeiro.
 */
@Injectable()
export class ListarVinculosAprovadosUseCase {
  constructor(
    @Inject(CONTACT_REPOSITORY) private readonly contactRepo: ContactRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patientRepo: PatientRepository,
  ) {}

  async execute(): Promise<LinkedContact[]> {
    const linked: LinkedContact[] = [];
    for (const { contact, associations } of await this.contactRepo.findLinked(MAX_LINKED_CONTACTS)) {
      if (!contact.phoneNumber) continue;
      const phoneNumber = contact.phoneNumber.toE164();
      const registered = new Set((await this.patientRepo.findAllByPhone(phoneNumber)).map((patient) => patient.id));
      for (const association of associations) {
        if (registered.has(association.patientId)) continue;
        const patient = await this.patientRepo.findById(association.patientId);
        if (!patient) continue;
        linked.push({
          contactId: contact.id,
          phoneNumber,
          patientId: patient.id,
          patientName: patient.name,
          linkedAt: association.createdAt,
        });
      }
    }
    return linked;
  }
}
