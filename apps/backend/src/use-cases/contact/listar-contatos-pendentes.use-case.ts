import { Injectable, Inject } from '@nestjs/common';
import { ContactState } from '@domain/contact/contact.entity';
import { ContactRepository, CONTACT_REPOSITORY } from '@domain-services/patient-ops/contact.repository';
import { PatientRepository, PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';

const MAX_PENDING_CONTACTS = 100;

export interface PendingContact {
  id: string;
  phoneNumber: string;
  /** O nome que a pessoa informou na conversa, se informou. Não foi conferido por ninguém. */
  name: string | null;
  state: ContactState;
  createdAt: Date;
}

/**
 * ListarContatosPendentesUseCase — ADR-0063 (AD-038). Os números que
 * escreveram para a clínica e ainda não identificam nenhum paciente: é a
 * lista de onde o administrador aprova um vínculo.
 *
 * Fica de fora o número que já consta no cadastro de algum paciente — esse é
 * reconhecido (ou ambíguo) pelo próprio cadastro e não tem vínculo a aprovar.
 *
 * No máximo 100, os de atividade mais recente primeiro. A conferência do
 * cadastro é feita número a número; a lista é pequena por construção.
 */
@Injectable()
export class ListarContatosPendentesUseCase {
  constructor(
    @Inject(CONTACT_REPOSITORY) private readonly contactRepo: ContactRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patientRepo: PatientRepository,
  ) {}

  async execute(): Promise<PendingContact[]> {
    const pending: PendingContact[] = [];
    for (const contact of await this.contactRepo.findUnlinked(MAX_PENDING_CONTACTS)) {
      if (!contact.phoneNumber) continue;
      const phoneNumber = contact.phoneNumber.toE164();
      if ((await this.patientRepo.findAllByPhone(phoneNumber)).length > 0) continue;
      pending.push({ id: contact.id, phoneNumber, name: contact.name, state: contact.state, createdAt: contact.createdAt });
    }
    return pending;
  }
}
