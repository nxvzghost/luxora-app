import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Contact } from '@domain/contact/contact.entity';
import { ContactRepository, CONTACT_REPOSITORY } from '@domain-services/patient-ops/contact.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { UnitOfWork, UNIT_OF_WORK } from '@domain-services/platform/unit-of-work';

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
 *
 * ADR-0063 (AD-038) — o contato é lido com a linha travada, na mesma
 * unidade de trabalho da gravação. Sem isso, um nome que chegasse no mesmo
 * instante em que a clínica aprova um vínculo regravava o estado lido antes
 * da aprovação e a desfazia. Agora a operação que chegar depois lê o
 * contato já vinculado, e o próprio Aggregate a recusa.
 */
@Injectable()
export class IdentificarContatoUseCase {
  constructor(
    @Inject(CONTACT_REPOSITORY) private readonly contactRepo: ContactRepository,
    private readonly auditService: AuditService,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(input: IdentificarContatoInput): Promise<Contact> {
    return this.unitOfWork.run(async () => {
      const contact = await this.contactRepo.findByIdForUpdate(input.contactId);
      if (!contact) {
        throw new NotFoundException(`Contact ${input.contactId} não encontrado.`);
      }

      contact.identificar(input.name);

      await this.contactRepo.save(contact);
      // Mesmo ator de PromoverContatoUseCase: a ação é decidida pelo roteador
      // a partir de uma classificação de IA.
      await this.auditService.recordAll(contact.pullDomainEvents(), 'ai_agent');

      return contact;
    });
  }
}
