import { Injectable, Inject, NotFoundException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Contact, ContactPatientAssociation } from '@domain/contact/contact.entity';
import { Patient } from '@domain/patient/patient.entity';
import { ContactRepository, CONTACT_REPOSITORY } from '@domain-services/patient-ops/contact.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { CadastrarPacienteUseCase } from '@use-cases/patient/cadastrar-paciente.use-case';

export interface PromoverContatoInput {
  contactId: string;
  patientName: string;
}

export interface PromoverContatoResult {
  contact: Contact;
  patient: Patient;
  association: ContactPatientAssociation;
}

/**
 * PromoverContatoUseCase — ADR-0055 (AD-018), Fase 6. Cenário 1/3
 * (ADR-0045, "primeira consulta agendada"): cria o Patient via
 * CadastrarPacienteUseCase (existente, inalterado) e promove o Contact
 * via Contact.promoverParaPaciente() — a única forma de mutar o Aggregate.
 * A validação de estado (só Identificado→Promovido é uma transição
 * válida) é inteiramente da StateMachine do Aggregate — este Use Case
 * nunca a duplica, só propaga o erro se a transição não for permitida
 * (ex.: Contact chamado duas vezes, já Promovido/Vinculado).
 */
@Injectable()
export class PromoverContatoUseCase {
  constructor(
    @Inject(CONTACT_REPOSITORY) private readonly contactRepo: ContactRepository,
    private readonly cadastrarPaciente: CadastrarPacienteUseCase,
    private readonly auditService: AuditService,
  ) {}

  async execute(input: PromoverContatoInput): Promise<PromoverContatoResult> {
    const contact = await this.contactRepo.findById(input.contactId);
    if (!contact) {
      throw new NotFoundException(`Contact ${input.contactId} não encontrado.`);
    }
    if (!contact.phoneNumber) {
      throw new ConflictException(`Contact ${input.contactId} não tem telefone (anonimizado) — não pode ser promovido.`);
    }

    const patient = await this.cadastrarPaciente.execute({
      name: input.patientName,
      phone: contact.phoneNumber.toE164(),
    });

    const association = contact.promoverParaPaciente(randomUUID(), patient.id);

    await this.contactRepo.save(contact);
    await this.contactRepo.saveAssociation(association);
    // Ator 'ai_agent' — ação decidida pelo ContactIntentActionRouter a
    // partir de uma classificação de IA, mesmo padrão de actorType já
    // usado por ProcessarMensagemUseCase para ações roteadas por IA.
    await this.auditService.recordAll(contact.pullDomainEvents(), 'ai_agent');

    return { contact, patient, association };
  }
}
