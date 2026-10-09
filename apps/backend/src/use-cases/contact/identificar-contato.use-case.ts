import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Contact } from '@domain/contact/contact.entity';
import { ContactRepository, CONTACT_REPOSITORY } from '@domain-services/patient-ops/contact.repository';
import { AuditService } from '@domain-services/platform/audit.service';

export interface IdentificarContatoInput {
  contactId: string;
  name: string;
}

/**
 * IdentificarContatoUseCase — ADR-0063 (AD-037). Guarda o nome completo que
 * a pessoa informou na conversa.
 *
 * Era o elo que faltava: `Contact.identificar()` existia no Aggregate e
 * ninguém o chamava, então o nome nunca era guardado e nenhum contato novo
 * chegava a virar paciente.
 *
 * Guardar o nome NÃO cria cadastro. O cadastro só nasce depois, quando a
 * pessoa confirma explicitamente (PromoverContatoUseCase). Chamar de novo
 * com outro nome, antes da confirmação, corrige o nome guardado.
 */
@Injectable()
export class IdentificarContatoUseCase {
  constructor(
    @Inject(CONTACT_REPOSITORY) private readonly contactRepo: ContactRepository,
    private readonly auditService: AuditService,
  ) {}

  async execute(input: IdentificarContatoInput): Promise<Contact> {
    const contact = await this.contactRepo.findById(input.contactId);
    if (!contact) {
      throw new NotFoundException(`Contact ${input.contactId} não encontrado.`);
    }

    contact.identificar(input.name);

    await this.contactRepo.save(contact);
    // Mesmo ator de PromoverContatoUseCase: a ação é decidida pelo roteador
    // a partir de uma classificação de IA.
    await this.auditService.recordAll(contact.pullDomainEvents(), 'ai_agent');

    return contact;
  }
}
