import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Contact, ContactPatientAssociation, ContactPatientRole } from '@domain/contact/contact.entity';
import { ContactRepository, CONTACT_REPOSITORY } from '@domain-services/patient-ops/contact.repository';
import { AuditService } from '@domain-services/platform/audit.service';

export interface AssociarContatoInput {
  contactId: string;
  patientId: string;
  role?: ContactPatientRole;
}

export interface AssociarContatoResult {
  contact: Contact;
  association: ContactPatientAssociation;
}

/**
 * AssociarContatoUseCase — ADR-0055 (AD-018), Fase 6. Cenário 11 tardio /
 * 12 (casal, dependente): associação ADICIONAL a um Contact que já está
 * Vinculado ou Promovido. `Contact.associarAPaciente()` já garante (nunca
 * duplicado aqui): (a) o estado permite associação adicional
 * (ContactNotQualifiedError caso contrário — ex.: Contact ainda sem
 * nenhuma associação, deveria ter sido PROMOVER, não ASSOCIAR); (b)
 * nenhum Patient duplicado (DuplicateContactPatientAssociationError).
 * Este Use Case só busca o estado necessário (associações existentes,
 * exigidas pela assinatura do Aggregate) e propaga qualquer erro de
 * domínio sem interpretá-lo.
 */
@Injectable()
export class AssociarContatoUseCase {
  constructor(
    @Inject(CONTACT_REPOSITORY) private readonly contactRepo: ContactRepository,
    private readonly auditService: AuditService,
  ) {}

  async execute(input: AssociarContatoInput): Promise<AssociarContatoResult> {
    const contact = await this.contactRepo.findById(input.contactId);
    if (!contact) {
      throw new NotFoundException(`Contact ${input.contactId} não encontrado.`);
    }

    const existingAssociations = await this.contactRepo.findAssociationsByContactId(input.contactId);
    const association = contact.associarAPaciente(
      randomUUID(),
      input.patientId,
      input.role ?? 'responsavel_por',
      existingAssociations,
    );

    await this.contactRepo.saveAssociation(association);
    await this.auditService.recordAll(contact.pullDomainEvents(), 'ai_agent');

    return { contact, association };
  }
}
