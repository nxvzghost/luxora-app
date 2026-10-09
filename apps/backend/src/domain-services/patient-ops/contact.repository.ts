import { Contact, ContactPatientAssociation } from '@domain/contact/contact.entity';
import { PhoneNumber } from '@domain/contact/phone-number.value-object';

/**
 * ContactRepository — porta (interface). ADR-0055 (AD-018). A implementação
 * real (Prisma) vive em infrastructure/, nunca aqui — domain-services/ não
 * pode importar infrastructure/ (regra de dependência arquitetural, ver
 * packages/config/eslint-preset.js). Mesmo Bounded Context de Patient
 * (ADR-0043) — por isso vive junto de PatientRepository nesta mesma pasta.
 */
export interface ContactRepository {
  findByTenantAndPhone(tenantId: string, phoneNumber: PhoneNumber): Promise<Contact | null>;
  findById(id: string): Promise<Contact | null>;
  /**
   * ADR-0063 (AD-038) — lê o Contact travando o registro até o fim da
   * unidade de trabalho em andamento (UnitOfWork). É por onde passa toda
   * operação que muda o estado de um Contact que já existe: duas delas
   * sobre o mesmo contato nunca correm ao mesmo tempo, e a segunda sempre
   * lê o que a primeira confirmou. Só pode ser chamado dentro de uma
   * unidade de trabalho.
   */
  findByIdForUpdate(id: string): Promise<Contact | null>;
  /** Persiste só o cabeçalho do Contact — nunca as associações (ver saveAssociation()). */
  save(contact: Contact): Promise<void>;
  /**
   * ADR-0063 (AD-038) — registra que o contato teve atividade, sem regravar
   * estado nem nome. É o que uma mensagem recebida faz com um Contact que já
   * existe.
   */
  touch(id: string): Promise<void>;
  /**
   * Persiste uma associação nova. Mesmo padrão de split já usado por
   * BillingRepository.save()/linkSessions() e ConversationRepository.save()/
   * appendMessages() — a associação está fora do limite de consistência de
   * Contact (11-Aggregates-e-Limites.md: "nunca uma composição"), nunca
   * persistida como parte do save() do Contact.
   */
  saveAssociation(association: ContactPatientAssociation): Promise<void>;
  findAssociationsByContactId(contactId: string): Promise<ContactPatientAssociation[]>;
  /**
   * ADR-0063 (AD-038) — Contacts da clínica que ainda não identificam
   * ninguém: sem nenhuma associação a paciente e ainda conversando ou só
   * com o nome informado. Os que tiveram atividade mais recente primeiro.
   * É a lista que a clínica vê no painel para aprovar um vínculo.
   */
  findUnlinked(limit: number): Promise<Contact[]>;
}

export const CONTACT_REPOSITORY = Symbol('CONTACT_REPOSITORY');
