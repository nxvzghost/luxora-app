import { Injectable, Inject, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Contact, ContactPatientAssociation } from '@domain/contact/contact.entity';
import { ContactRepository, CONTACT_REPOSITORY } from '@domain-services/patient-ops/contact.repository';
import { PatientRepository, PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { UnitOfWork, UNIT_OF_WORK } from '@domain-services/platform/unit-of-work';
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
 * o id dele vem da sessão autenticada, nunca do corpo da requisição.
 *
 * UMA TRANSAÇÃO, COM O CONTATO TRAVADO. Tudo acontece dentro de uma unidade
 * de trabalho:
 *
 * - a linha do contato é travada antes de qualquer conferência. Duas
 *   aprovações do mesmo contato não correm ao mesmo tempo: a segunda espera
 *   a primeira confirmar, lê o vínculo que já existe e é recusada (409).
 *   Antes, as duas liam "sem vínculo" e as duas gravavam — o contato ficava
 *   com dois pacientes;
 * - a mudança do contato, o vínculo e os registros de auditoria são
 *   confirmados juntos. Se qualquer gravação falhar — inclusive a da
 *   auditoria —, nada fica gravado. Antes, o vínculo podia existir sem o
 *   registro de quem aprovou;
 * - o horário da aprovação é um só, tomado dentro da transação depois de a
 *   aprovação obter a trava. O vínculo e o registro de auditoria são
 *   gravados em seguida, na mesma transação e pelo mesmo relógio (é o
 *   Prisma, na aplicação, que preenche `created_at` — não o banco).
 *
 * As leituras passam pela RLS: um contato ou um paciente de outra clínica é
 * o mesmo que inexistente (404), nada é gravado e nada é travado.
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
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(input: VincularContatoAPacienteInput): Promise<VincularContatoAPacienteResult> {
    const approvedByUserId = this.tenantContext.userId;
    if (!approvedByUserId) {
      throw new ForbiddenException('O vínculo de um número a um paciente precisa ser aprovado por um usuário da clínica.');
    }

    return this.unitOfWork.run(async () => {
      const contact = await this.contactRepo.findByIdForUpdate(input.contactId);
      if (!contact) {
        throw new NotFoundException('Contato não encontrado.');
      }
      const patient = await this.patientRepo.findById(input.patientId);
      if (!patient) {
        throw new NotFoundException('Paciente não encontrado.');
      }

      // Lido com o contato já travado: é o estado que vale, não o de antes.
      const associations = await this.contactRepo.findAssociationsByContactId(contact.id);
      if (associations.length > 0) {
        throw new ConflictException('Este número já está vinculado a um paciente.');
      }
      if (!contact.phoneNumber || !['Novo', 'Conversando', 'Identificado'].includes(contact.state)) {
        throw new ConflictException('Este contato não pode mais ser vinculado a um paciente.');
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

      // Um horário só, tomado uma vez, já com o contato travado e todas as
      // conferências feitas: é o que vai na resposta e no registro de
      // auditoria. Uma aprovação que ficou esperando a outra terminar não
      // carrega o horário de quando começou a esperar.
      const approvedAt = new Date();
      const association = contact.vincularAPacienteExistente(randomUUID(), patient.id, { approvedByUserId, approvedAt });

      await this.contactRepo.save(contact);
      await this.contactRepo.saveAssociation(association);
      // Ator 'user': a trilha guarda o id de quem aprovou e o horário. Na
      // mesma transação: sem o registro, o vínculo não existe.
      await this.auditService.recordAll(contact.pullDomainEvents());

      return { contact, association, approvedByUserId, approvedAt };
    });
  }
}
