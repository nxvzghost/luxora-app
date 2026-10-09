import { Injectable, Inject } from '@nestjs/common';
import { Contact } from '@domain/contact/contact.entity';
import { ContactRepository, CONTACT_REPOSITORY } from '@domain-services/patient-ops/contact.repository';
import { PatientRepository, PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';

/**
 * Quem está do outro lado de um número — ADR-0063 (AD-037 e AD-038).
 *
 * - `recognized`: o número corresponde a exatamente um paciente da clínica;
 * - `ambiguous`: corresponde a dois ou mais. Ninguém é escolhido — nem o
 *   cadastro mais antigo — e nenhum dos candidatos sai daqui;
 * - `unknown`: não corresponde a nenhum.
 */
export type SenderIdentity =
  | { status: 'recognized'; patientId: string }
  | { status: 'ambiguous' }
  | { status: 'unknown' };

/**
 * ResolverIdentidadeDoContatoUseCase — a única regra que diz a quem um número
 * de WhatsApp pertence. Calculada a cada mensagem, nunca guardada: se a
 * clínica cadastra um segundo paciente com o mesmo número, a mensagem
 * seguinte já é tratada como ambígua.
 *
 * Um número identifica um paciente por dois caminhos, e só por eles:
 *
 * 1. o telefone do cadastro do paciente, gravado pela clínica (ou pelo
 *    próprio cadastro feito no WhatsApp, depois do nome completo e da
 *    confirmação);
 * 2. um vínculo aprovado pela clínica no painel — o Contact em `Vinculado`
 *    (decisão 3 da ADR-0063).
 *
 * O nome de perfil do WhatsApp, o nome dito na conversa e a confirmação de
 * quem escreve não identificam ninguém.
 */
@Injectable()
export class ResolverIdentidadeDoContatoUseCase {
  constructor(
    @Inject(CONTACT_REPOSITORY) private readonly contactRepo: ContactRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patientRepo: PatientRepository,
  ) {}

  async execute(contact: Contact): Promise<SenderIdentity> {
    if (!contact.phoneNumber) {
      return { status: 'unknown' };
    }

    const patientIds = new Set<string>();
    for (const patient of await this.patientRepo.findAllByPhone(contact.phoneNumber.toE164())) {
      patientIds.add(patient.id);
    }
    if (contact.state === 'Vinculado') {
      for (const association of await this.contactRepo.findAssociationsByContactId(contact.id)) {
        patientIds.add(association.patientId);
      }
    }

    if (patientIds.size === 0) return { status: 'unknown' };
    if (patientIds.size > 1) return { status: 'ambiguous' };
    const [patientId] = patientIds;
    return { status: 'recognized', patientId };
  }
}
