import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Contact, ContactPatientAssociation } from '@domain/contact/contact.entity';
import { ContactRepository, CONTACT_REPOSITORY } from '@domain-services/patient-ops/contact.repository';

export interface ConsultarContatoResult {
  contact: Contact;
  associations: ContactPatientAssociation[];
}

/**
 * ConsultarContatoUseCase — ADR-0055 (AD-018), Fase 6. Único ponto de
 * leitura de Contact + suas associações usado por ContactIntentActionRouter
 * — o Router nunca acessa ContactRepository diretamente.
 */
@Injectable()
export class ConsultarContatoUseCase {
  constructor(@Inject(CONTACT_REPOSITORY) private readonly contactRepo: ContactRepository) {}

  async execute(contactId: string): Promise<ConsultarContatoResult> {
    const contact = await this.contactRepo.findById(contactId);
    if (!contact) {
      throw new NotFoundException(`Contact ${contactId} não encontrado.`);
    }

    const associations = await this.contactRepo.findAssociationsByContactId(contactId);
    return { contact, associations };
  }
}
