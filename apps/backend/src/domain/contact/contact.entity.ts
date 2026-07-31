import { StateMachine } from '../shared/state-machine';
import { DomainEvent } from '../shared/domain-event';
import { PhoneNumber } from './phone-number.value-object';

/**
 * Contact — ADR-0055 (AD-018), Marco 1 da Arquitetura de Domínio
 * (ADR-0043 a ADR-0046). Mesmo Bounded Context de Patient — Contact nunca
 * representa vínculo clínico, só identidade de quem está conversando por
 * um canal (docs/01-Domain/08-Contact-e-Identidade-de-Comunicacao.md).
 *
 * Invariante que protege (11-Aggregates-e-Limites.md): uma identidade de
 * comunicação nunca existe sem ao menos um dado de canal — por isso
 * `create()` exige PhoneNumber, nunca nulo; só `anonimizar()` (mutação
 * explícita, deliberada, fora do ciclo normal) o remove depois.
 *
 * `Qualificado` (citado nos documentos de domínio) nunca é um estado
 * persistido — colapsa em `Promovido` dentro de promoverParaPaciente(),
 * mesmo padrão já usado por Patient.Novo/Identificado dentro de
 * CadastrarPacienteUseCase (várias transições numa única operação
 * síncrona, um único evento durável no fim).
 */
export type ContactState =
  | 'Novo'
  | 'Conversando'
  | 'Identificado'
  | 'Vinculado'
  | 'Promovido'
  | 'Arquivado'
  | 'Descartado';

export type ContactPatientRole = 'proprio_paciente' | 'responsavel_por';

/**
 * Tabela de transições do Contact.
 * Fonte: docs/01-Domain/08-Contact-e-Identidade-de-Comunicacao.md, "Ciclo de
 * vida"; docs/01-Domain/13-Process-Managers.md, "Processo de Qualificação
 * do Contato" e "Processo de Retenção/Expurgo de Contato".
 *
 * `Identificado` nunca transiciona para `Arquivado` — só `Novo`/
 * `Conversando` alimentam o Processo de Retenção/Expurgo (13-Process-
 * Managers.md: "Contact permanece em Novo/Conversando sem nunca avançar").
 * Um Contact que já chegou a `Identificado` já tem nome capturado — sair
 * daí sem qualificar não está coberto pelos documentos congelados desta
 * fase, e não deve ser inferido silenciosamente.
 */
const contactTransitions: Record<ContactState, readonly ContactState[]> = {
  Novo: ['Conversando', 'Arquivado'],
  Conversando: ['Identificado', 'Arquivado'],
  Identificado: ['Vinculado', 'Promovido'],
  Vinculado: [],
  Promovido: [],
  Arquivado: ['Descartado'],
  Descartado: [],
};

const contactStateMachine = new StateMachine<ContactState>('Contact', contactTransitions);

/**
 * Lançado quando se tenta associar um segundo Patient a um Contact que
 * ainda não passou pela qualificação (ainda Novo/Conversando/Identificado
 * sem nenhuma associação prévia) — associação adicional só faz sentido
 * depois que o Contact já está Vinculado ou Promovido (já tem ao menos
 * uma associação, ver associarAPaciente()).
 */
export class ContactNotQualifiedError extends Error {
  constructor(contactId: string, currentState: ContactState) {
    super(
      `Contact ${contactId} não pode receber uma associação adicional no estado "${currentState}" — só depois de já estar Vinculado ou Promovido.`,
    );
    this.name = 'ContactNotQualifiedError';
  }
}

export class DuplicateContactPatientAssociationError extends Error {
  constructor(contactId: string, patientId: string) {
    super(`O Contact ${contactId} já está associado ao Patient ${patientId} — associação duplicada não é permitida.`);
    this.name = 'DuplicateContactPatientAssociationError';
  }
}

export class BlankContactNameError extends Error {
  constructor() {
    super('Nome do Contact não pode ser vazio ao identificar.');
    this.name = 'BlankContactNameError';
  }
}

// ─────────────────────────────────────────────
// Domain Events — docs/01-Domain/12-Domain-Events.md ("Fase WhatsApp/Contact")
// ─────────────────────────────────────────────

export class ContactCreatedEvent extends DomainEvent {
  constructor(contactId: string, tenantId: string) {
    super('ContatoCriado', contactId, tenantId);
  }
}

export class ContactInteractedEvent extends DomainEvent {
  constructor(contactId: string, tenantId: string) {
    super('ContatoInteragiu', contactId, tenantId);
  }
}

export class ContactIdentifiedEvent extends DomainEvent {
  declare readonly name: string;

  constructor(contactId: string, tenantId: string, name: string) {
    super('ContatoIdentificado', contactId, tenantId, { name });
  }
}

export class ContactAssociatedToPatientEvent extends DomainEvent {
  declare readonly patientId: string;
  declare readonly role: ContactPatientRole;

  constructor(contactId: string, tenantId: string, patientId: string, role: ContactPatientRole) {
    super('ContatoAssociadoAPaciente', contactId, tenantId, { patientId, role });
  }
}

/** Disparado por "primeira consulta agendada" (ADR-0045) — Patient novo ou primeira associação real. */
export class ContactPromotedToPatientEvent extends DomainEvent {
  declare readonly patientId: string;

  constructor(contactId: string, tenantId: string, patientId: string) {
    super('ContatoPromovidoParaPaciente', contactId, tenantId, { patientId });
  }
}

/** Cenário 13 — troca de número, só após confirmação explícita (ADR-0046). */
export class ContactLinkedToExistingPatientEvent extends DomainEvent {
  declare readonly patientId: string;

  constructor(contactId: string, tenantId: string, patientId: string) {
    super('ContatoVinculadoAPacienteExistente', contactId, tenantId, { patientId });
  }
}

/** Cenário 14 — telefone bate direto com Patient cadastrado pelo painel, qualificação inteira pulada. */
export class ContactReconciledWithExistingPatientEvent extends DomainEvent {
  declare readonly patientId: string;

  constructor(contactId: string, tenantId: string, patientId: string) {
    super('ContatoReconciliadoComPacienteExistente', contactId, tenantId, { patientId });
  }
}

export class ContactArchivedEvent extends DomainEvent {
  constructor(contactId: string, tenantId: string) {
    super('ContatoArquivado', contactId, tenantId);
  }
}

export class ContactAnonymizedEvent extends DomainEvent {
  constructor(contactId: string, tenantId: string) {
    super('ContatoAnonimizado', contactId, tenantId);
  }
}

// ─────────────────────────────────────────────
// ContactPatientAssociation — Entity (nunca Aggregate Root própria,
// ver 11-Aggregates-e-Limites.md: "não há invariante que justifique isso").
// Nunca uma FK única em Contact ou Patient — várias por Contact (casal) e
// várias por Patient ao longo do tempo (troca de número) são o caso normal.
// ─────────────────────────────────────────────

export interface ContactPatientAssociationProps {
  id: string;
  tenantId: string;
  contactId: string;
  patientId: string;
  role: ContactPatientRole;
  createdAt?: Date;
}

export class ContactPatientAssociation {
  private constructor(private readonly props: Required<ContactPatientAssociationProps>) {}

  static create(props: Omit<ContactPatientAssociationProps, 'createdAt'>): ContactPatientAssociation {
    return new ContactPatientAssociation({ ...props, createdAt: new Date() });
  }

  static reconstitute(props: ContactPatientAssociationProps): ContactPatientAssociation {
    return new ContactPatientAssociation({ ...props, createdAt: props.createdAt ?? new Date() });
  }

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get contactId(): string {
    return this.props.contactId;
  }

  get patientId(): string {
    return this.props.patientId;
  }

  get role(): ContactPatientRole {
    return this.props.role;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }
}

// ─────────────────────────────────────────────
// Contact — Aggregate Root
// ─────────────────────────────────────────────

interface ContactInternalProps {
  id: string;
  tenantId: string;
  /** Nulo só depois de anonimizar() — nunca nulo em qualquer outro estado. */
  phoneNumber: PhoneNumber | null;
  name: string | null;
  state: ContactState;
  createdAt: Date;
}

export interface ContactProps {
  id: string;
  tenantId: string;
  phoneNumber: PhoneNumber | null;
  name?: string | null;
  state: ContactState;
  createdAt?: Date;
}

export class Contact {
  private _pendingEvents: DomainEvent[] = [];

  private constructor(private readonly props: ContactInternalProps) {}

  /** Único ponto de criação do caminho normal — sempre nasce Novo (Cenário 1). */
  static create(props: { id: string; tenantId: string; phoneNumber: PhoneNumber }): Contact {
    return new Contact({
      id: props.id,
      tenantId: props.tenantId,
      phoneNumber: props.phoneNumber,
      name: null,
      state: 'Novo',
      createdAt: new Date(),
    });
  }

  /**
   * Cenário 14 — telefone normalizado bate direto com um Patient já
   * cadastrado pelo painel. O Contact nasce já `Vinculado`, pulando toda a
   * fase de qualificação (Novo/Conversando/Identificado nunca acontecem) —
   * ver docs/01-Domain/07-Event-Storming-WhatsApp.md, Cenário 14.
   */
  static createAlreadyLinked(props: {
    id: string;
    tenantId: string;
    phoneNumber: PhoneNumber;
    associationId: string;
    patientId: string;
  }): { contact: Contact; association: ContactPatientAssociation } {
    const contact = new Contact({
      id: props.id,
      tenantId: props.tenantId,
      phoneNumber: props.phoneNumber,
      name: null,
      state: 'Vinculado',
      createdAt: new Date(),
    });

    const association = ContactPatientAssociation.create({
      id: props.associationId,
      tenantId: props.tenantId,
      contactId: props.id,
      patientId: props.patientId,
      role: 'proprio_paciente',
    });

    contact._pendingEvents.push(
      new ContactCreatedEvent(props.id, props.tenantId),
      new ContactAssociatedToPatientEvent(props.id, props.tenantId, props.patientId, 'proprio_paciente'),
      new ContactReconciledWithExistingPatientEvent(props.id, props.tenantId, props.patientId),
    );

    return { contact, association };
  }

  static reconstitute(props: ContactProps): Contact {
    return new Contact({
      id: props.id,
      tenantId: props.tenantId,
      phoneNumber: props.phoneNumber,
      name: props.name ?? null,
      state: props.state,
      createdAt: props.createdAt ?? new Date(),
    });
  }

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get phoneNumber(): PhoneNumber | null {
    return this.props.phoneNumber;
  }

  get name(): string | null {
    return this.props.name;
  }

  get state(): ContactState {
    return this.props.state;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  /**
   * Cenário 1/2 — primeiro contato e mensagens seguintes sem nome
   * capturado. Idempotente por natureza: uma vez além de `Novo`, chamar de
   * novo não é um fato novo e não gera evento nem tenta transição — uma
   * conversa tem N mensagens, só a primeira faz o Contact avançar.
   */
  interagir(): void {
    if (this.props.state !== 'Novo') {
      return;
    }
    contactStateMachine.assertTransition(this.props.state, 'Conversando');
    this.props.state = 'Conversando';
    this._pendingEvents.push(new ContactInteractedEvent(this.props.id, this.props.tenantId));
  }

  /** Cenário 2 (avanço) — nome capturado na conversa. */
  identificar(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new BlankContactNameError();
    }
    contactStateMachine.assertTransition(this.props.state, 'Identificado');
    this.props.name = trimmed;
    this.props.state = 'Identificado';
    this._pendingEvents.push(new ContactIdentifiedEvent(this.props.id, this.props.tenantId, trimmed));
  }

  /**
   * Cenário 3 — evento de negócio "primeira consulta agendada" (ADR-0045).
   * Cobre tanto o caso comum (proprio_paciente, Patient novo) quanto o
   * primeiro vínculo de responsável/dependente (Cenário 11) quando esta é
   * a primeira associação do Contact — em ambos os casos é genuinamente a
   * primeira consulta agendada por este Contact, o mesmo evento de
   * domínio, só o papel muda.
   */
  promoverParaPaciente(
    associationId: string,
    patientId: string,
    role: ContactPatientRole = 'proprio_paciente',
  ): ContactPatientAssociation {
    contactStateMachine.assertTransition(this.props.state, 'Promovido');

    const association = ContactPatientAssociation.create({
      id: associationId,
      tenantId: this.props.tenantId,
      contactId: this.props.id,
      patientId,
      role,
    });

    this.props.state = 'Promovido';
    this._pendingEvents.push(
      new ContactAssociatedToPatientEvent(this.props.id, this.props.tenantId, patientId, role),
      new ContactPromotedToPatientEvent(this.props.id, this.props.tenantId, patientId),
    );

    return association;
  }

  /**
   * Cenário 13 — troca de número. Só deve ser chamado depois de
   * confirmação explícita (ADR-0046) — a confirmação em si é
   * responsabilidade do caso de uso/IA, nunca desta entidade; aqui só se
   * garante que a transição de estado é válida e o evento correto nasce.
   */
  vincularAPacienteExistente(associationId: string, patientId: string): ContactPatientAssociation {
    contactStateMachine.assertTransition(this.props.state, 'Vinculado');

    const association = ContactPatientAssociation.create({
      id: associationId,
      tenantId: this.props.tenantId,
      contactId: this.props.id,
      patientId,
      role: 'proprio_paciente',
    });

    this.props.state = 'Vinculado';
    this._pendingEvents.push(
      new ContactAssociatedToPatientEvent(this.props.id, this.props.tenantId, patientId, 'proprio_paciente'),
      new ContactLinkedToExistingPatientEvent(this.props.id, this.props.tenantId, patientId),
    );

    return association;
  }

  /**
   * Associação adicional a um Contact que já qualificou (Cenário 11
   * tardio, ou casal — Cenário 12 — recebendo o segundo Patient). Nunca
   * muda o estado — Vinculado/Promovido já são terminais de qualificação.
   *
   * `existingAssociations` é passado pelo chamador a cada chamada, nunca
   * guardado internamente — a associação Contact↔Patient está
   * deliberadamente FORA do limite de consistência de Contact
   * (11-Aggregates-e-Limites.md: "nunca uma composição"); esta entidade
   * não carrega suas próprias associações em memória, só sabe validar a
   * regra de não-duplicidade quando a lista é fornecida.
   */
  associarAPaciente(
    associationId: string,
    patientId: string,
    role: ContactPatientRole,
    existingAssociations: readonly ContactPatientAssociation[],
  ): ContactPatientAssociation {
    if (this.props.state !== 'Vinculado' && this.props.state !== 'Promovido') {
      throw new ContactNotQualifiedError(this.props.id, this.props.state);
    }
    if (existingAssociations.some((a) => a.patientId === patientId)) {
      throw new DuplicateContactPatientAssociationError(this.props.id, patientId);
    }

    const association = ContactPatientAssociation.create({
      id: associationId,
      tenantId: this.props.tenantId,
      contactId: this.props.id,
      patientId,
      role,
    });

    this._pendingEvents.push(new ContactAssociatedToPatientEvent(this.props.id, this.props.tenantId, patientId, role));

    return association;
  }

  /** Ramo de retenção (Cenário 15) — só capacidade de domínio nesta AD, sem scheduler (ADR-0055, escopo). */
  arquivar(): void {
    contactStateMachine.assertTransition(this.props.state, 'Arquivado');
    this.props.state = 'Arquivado';
    this._pendingEvents.push(new ContactArchivedEvent(this.props.id, this.props.tenantId));
  }

  /** Expurgo de LGPD — remove dado pessoal, preserva a linha para contagem agregada (08-Contact..., seção LGPD). */
  anonimizar(): void {
    contactStateMachine.assertTransition(this.props.state, 'Descartado');
    this.props.phoneNumber = null;
    this.props.name = null;
    this.props.state = 'Descartado';
    this._pendingEvents.push(new ContactAnonymizedEvent(this.props.id, this.props.tenantId));
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }
}
