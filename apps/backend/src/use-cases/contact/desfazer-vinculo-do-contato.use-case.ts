import { Injectable, Inject, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Contact } from '@domain/contact/contact.entity';
import { ContactRepository, CONTACT_REPOSITORY } from '@domain-services/patient-ops/contact.repository';
import { PatientRepository, PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { UnitOfWork, UNIT_OF_WORK } from '@domain-services/platform/unit-of-work';
import { TenantContext } from '@shared/tenant-context';

export interface DesfazerVinculoDoContatoInput {
  contactId: string;
  patientId: string;
}

export interface DesfazerVinculoDoContatoResult {
  contact: Contact;
  patientId: string;
  undoneByUserId: string;
  undoneAt: Date;
}

/**
 * DesfazerVinculoDoContatoUseCase — A-10 da auditoria (19/10/2026).
 *
 * Desfaz o vínculo de um número a um paciente que a própria clínica aprovou
 * (VincularContatoAPacienteUseCase). Até aqui não havia como: um vínculo
 * aprovado por engano dava a um número o reconhecimento de outro paciente, e
 * só se corrigia no banco.
 *
 * Decisões registradas (ADR-0066):
 * - só o administrador desfaz, como só ele aprova; o id de quem desfez vem da
 *   sessão, nunca do corpo da requisição;
 * - só o vínculo aprovado: se o número consta no cadastro do paciente, o
 *   cadastro é que o identifica, e a resposta (409) manda alterar o cadastro;
 * - sem outro vínculo, o contato volta a `Identificado` e reaparece entre os
 *   números aguardando vínculo; a conversa não é apagada.
 *
 * Mesma disciplina da aprovação: uma unidade de trabalho, com o contato
 * travado antes de qualquer conferência; o vínculo apagado, o contato e o
 * registro de auditoria são confirmados juntos, ou nada fica gravado.
 */
@Injectable()
export class DesfazerVinculoDoContatoUseCase {
  constructor(
    @Inject(CONTACT_REPOSITORY) private readonly contactRepo: ContactRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patientRepo: PatientRepository,
    private readonly auditService: AuditService,
    private readonly tenantContext: TenantContext,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(input: DesfazerVinculoDoContatoInput): Promise<DesfazerVinculoDoContatoResult> {
    const undoneByUserId = this.tenantContext.userId;
    if (!undoneByUserId) {
      throw new ForbiddenException('Desfazer o vínculo de um número precisa ser feito por um usuário da clínica.');
    }

    return this.unitOfWork.run(async () => {
      const contact = await this.contactRepo.findByIdForUpdate(input.contactId);
      if (!contact) {
        throw new NotFoundException('Contato não encontrado.');
      }

      const associations = await this.contactRepo.findAssociationsByContactId(contact.id);
      const target = associations.find((association) => association.patientId === input.patientId);
      if (!target || contact.state !== 'Vinculado') {
        throw new NotFoundException('Este número não está vinculado a esse paciente.');
      }

      const phone = contact.phoneNumber?.toE164();
      if (phone && (await this.patientRepo.findAllByPhone(phone)).some((patient) => patient.id === input.patientId)) {
        throw new ConflictException(
          'Este número consta no cadastro do paciente: é o cadastro que o identifica. Para mudar isso, altere o telefone no cadastro.',
        );
      }

      const undoneAt = new Date();
      await this.contactRepo.deleteAssociation(target.id);
      contact.desfazerVinculo(target.patientId, { undoneByUserId, undoneAt }, associations.length - 1);
      await this.contactRepo.save(contact);
      // Ator 'user', na mesma transação: sem o registro, o vínculo não é desfeito.
      await this.auditService.recordAll(contact.pullDomainEvents());

      return { contact, patientId: target.patientId, undoneByUserId, undoneAt };
    });
  }
}
