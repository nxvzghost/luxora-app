import { Injectable, Inject, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Contact, ContactPatientAssociation } from '@domain/contact/contact.entity';
import { ContactRepository, CONTACT_REPOSITORY } from '@domain-services/patient-ops/contact.repository';
import { PatientRepository, PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { TenantContext } from '@shared/tenant-context';

export interface VincularContatoAPacienteInput {
  contactId: string;
  patientId: string;
}

export interface VincularContatoAPacienteResult {
  contact: Contact;
  association: ContactPatientAssociation;
  approvedByUserId: string;
  approvedAt: Date;
}

/**
 * VincularContatoAPacienteUseCase — ADR-0063, decisão 3 (AD-038).
 *
 * A aprovação, pela clínica, do vínculo de um número novo a um paciente que
 * já existe. É o único caminho que cria esse vínculo: o pipeline do
 * WhatsApp nunca chama este caso de uso, e o que a pessoa disser pelo
 * próprio número novo não vincula nada.
 *
 * Quem aprova é o usuário da requisição (a rota restringe ao administrador);
 * o id dele e o horário vão no evento de domínio e ficam gravados na trilha
 * de auditoria, que não pode ser alterada.
 *
 * As leituras passam pela RLS: um contato ou um paciente de outra clínica é
 * o mesmo que inexistente (404), e nada é gravado.
 *
 * O telefone do cadastro do paciente NÃO é alterado — a aprovação acrescenta
 * um número que identifica o paciente, não substitui o anterior.
 */
@Injectable()
export class VincularContatoAPacienteUseCase {
  constructor(
    @Inject(CONTACT_REPOSITORY) private readonly contactRepo: ContactRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patientRepo: PatientRepository,
    private readonly auditService: AuditService,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(input: VincularContatoAPacienteInput): Promise<VincularContatoAPacienteResult> {
    const approvedByUserId = this.tenantContext.userId;
    if (!approvedByUserId) {
      throw new ForbiddenException('O vínculo de um número a um paciente precisa ser aprovado por um usuário da clínica.');
    }

    const contact = await this.contactRepo.findById(input.contactId);
    if (!contact) {
      throw new NotFoundException('Contato não encontrado.');
    }
    const patient = await this.patientRepo.findById(input.patientId);
    if (!patient) {
      throw new NotFoundException('Paciente não encontrado.');
    }

    if (!contact.phoneNumber || !['Novo', 'Conversando', 'Identificado'].includes(contact.state)) {
      throw new ConflictException('Este contato não pode mais ser vinculado a um paciente.');
    }
    const associations = await this.contactRepo.findAssociationsByContactId(contact.id);
    if (associations.length > 0) {
      throw new ConflictException('Este número já está vinculado a um paciente.');
    }
    const registered = await this.patientRepo.findAllByPhone(contact.phoneNumber.toE164());
    if (registered.length > 0) {
      throw new ConflictException('Este número já consta no cadastro de um paciente da clínica.');
    }

    // A aprovação da clínica é o que identifica o contato: se a pessoa ainda
    // não tinha informado um nome, ele passa a ser o do paciente aprovado.
    if (contact.state === 'Novo') {
      contact.interagir();
    }
    if (contact.state === 'Conversando') {
      contact.identificar(patient.name);
    }

    const approvedAt = new Date();
    const association = contact.vincularAPacienteExistente(randomUUID(), patient.id, { approvedByUserId, approvedAt });

    await this.contactRepo.save(contact);
    await this.contactRepo.saveAssociation(association);
    // Ator 'user': a trilha guarda o id de quem aprovou e o horário.
    await this.auditService.recordAll(contact.pullDomainEvents());

    return { contact, association, approvedByUserId, approvedAt };
  }
}
