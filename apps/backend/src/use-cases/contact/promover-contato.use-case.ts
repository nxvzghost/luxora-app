import { Injectable, Inject, NotFoundException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Contact, ContactPatientAssociation } from '@domain/contact/contact.entity';
import { Patient } from '@domain/patient/patient.entity';
import { ContactRepository, CONTACT_REPOSITORY } from '@domain-services/patient-ops/contact.repository';
import { PatientRepository, PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { UnitOfWork, UNIT_OF_WORK } from '@domain-services/platform/unit-of-work';
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
 * Já existe na clínica um paciente com este mesmo nome. Pode ser a mesma
 * pessoa escrevendo de um número novo, pode ser um homônimo — o sistema não
 * tem como saber, e por isso não abre um segundo cadastro: o caso vai para a
 * clínica (ADR-0063).
 *
 * A mensagem não traz o nome nem o id de ninguém e NÃO diz que existe outro
 * cadastro: quem sabe o motivo é o código (pela classe do erro), não o
 * texto. Se um dia este erro chegar a uma resposta, ela não confirma a
 * existência de paciente nenhum.
 */
export class PossibleDuplicatePatientError extends ConflictException {
  constructor() {
    super('O cadastro precisa ser concluído pela equipe da clínica.');
    this.name = 'PossibleDuplicatePatientError';
  }
}

/**
 * PromoverContatoUseCase — ADR-0055 (AD-018), Fase 6. Cenário 1/3
 * (ADR-0045, "primeira consulta agendada"): cria o Patient via
 * CadastrarPacienteUseCase (existente, inalterado) e promove o Contact
 * via Contact.promoverParaPaciente() — a única forma de mutar o Aggregate.
 *
 * ADR-0063 (AD-037) — nunca abre um cadastro duplicado. Antes de criar o
 * paciente, três conferências, e qualquer uma delas recusa SEM gravar nada:
 *
 * 1. o Contact tem de estar `Identificado` — com o nome já guardado em uma
 *    mensagem anterior. Antes, o paciente era criado primeiro e a transição
 *    de estado só era conferida depois: uma promoção fora de hora deixava
 *    um paciente gravado sem contato;
 * 2. o número não pode constar no cadastro de nenhum paciente da clínica
 *    (a lacuna D5b);
 * 3. não pode existir paciente com o mesmo nome (PossibleDuplicatePatientError).
 *
 * Quem decide QUANDO promover — só depois da confirmação explícita — é o
 * ContactIntentActionRouter.
 *
 * ADR-0063 (AD-038) — uma unidade de trabalho, com o contato travado. A
 * promoção e a aprovação de um vínculo pela clínica mudam o mesmo contato;
 * sem a trava, as duas ao mesmo tempo deixavam o contato com dois pacientes
 * e a aprovação sem efeito. Agora a que chegar depois lê o que a primeira
 * confirmou e é recusada. De quebra, o paciente, o contato, a associação e
 * os registros de auditoria passam a ser confirmados juntos: uma falha no
 * meio não deixa mais um paciente gravado sem contato, e duas confirmações
 * simultâneas da mesma pessoa não criam dois cadastros.
 */
@Injectable()
export class PromoverContatoUseCase {
  constructor(
    @Inject(CONTACT_REPOSITORY) private readonly contactRepo: ContactRepository,
    private readonly cadastrarPaciente: CadastrarPacienteUseCase,
    private readonly auditService: AuditService,
    @Inject(PATIENT_REPOSITORY) private readonly patientRepo: PatientRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(input: PromoverContatoInput): Promise<PromoverContatoResult> {
    return this.unitOfWork.run(async () => {
      const contact = await this.contactRepo.findByIdForUpdate(input.contactId);
      if (!contact) {
        throw new NotFoundException(`Contact ${input.contactId} não encontrado.`);
      }
      if (!contact.phoneNumber) {
        throw new ConflictException(`Contact ${input.contactId} não tem telefone (anonimizado) — não pode ser promovido.`);
      }
      if (contact.state !== 'Identificado') {
        throw new ConflictException(`Contact ${input.contactId} não pode ser promovido no estado "${contact.state}".`);
      }

      const phoneNumber = contact.phoneNumber.toE164();
      if ((await this.patientRepo.findAllByPhone(phoneNumber)).length > 0) {
        throw new ConflictException('Este número já consta no cadastro de um paciente da clínica.');
      }
      if ((await this.patientRepo.findAllByName(input.patientName)).length > 0) {
        throw new PossibleDuplicatePatientError();
      }

      const patient = await this.cadastrarPaciente.execute({
        name: input.patientName,
        phone: phoneNumber,
      });

      const association = contact.promoverParaPaciente(randomUUID(), patient.id);

      await this.contactRepo.save(contact);
      await this.contactRepo.saveAssociation(association);
      // Ator 'ai_agent' — ação decidida pelo ContactIntentActionRouter a
      // partir de uma classificação de IA, mesmo padrão de actorType já
      // usado por ProcessarMensagemUseCase para ações roteadas por IA.
      await this.auditService.recordAll(contact.pullDomainEvents(), 'ai_agent');

      return { contact, patient, association };
    });
  }
}
