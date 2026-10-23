import { StateMachine } from '../shared/state-machine';
import { DomainEvent } from '../shared/domain-event';

/**
 * Estados da Sessão (atendimento em si — distinto do Agendamento/reserva).
 *
 * Fonte: docs/01-Domain/03-Maquina-de-Estados.md, seção "Sessão", subconjunto
 * final; resolvido em docs/01-Domain/05-Linguagem-Ubiqua.md.
 *
 * K2-b (ADR-0069, seções 2.9 e 3.4) — a sessão é o ITEM FATURÁVEL de uma
 * consulta. `Realizada` continua sendo o nome do estado inicial ("a
 * faturar"), por compatibilidade com as versões anteriores; o que a sessão
 * cobra está em `kind`. Ela só nasce (ou é reaproveitada) de um desfecho
 * registrado por pessoa: realização (T6) ou cobrança de falta confirmada
 * (T8). Confirmar a consulta não cria sessão.
 */
export type SessionState = 'Realizada' | 'Faturada' | 'Recebida';
export type SessionKind = 'atendimento' | 'falta' | 'aviso_fora_do_prazo' | 'aviso_tardio';
export type BillingEligibility = 'elegivel' | 'nao_elegivel';
export type SessionVoidReason = 'desfecho_corrigido' | 'legado_consulta_cancelada' | 'legado_consulta_futura';

const sessionTransitions: Record<SessionState, readonly SessionState[]> = {
  Realizada: ['Faturada'],
  Faturada: ['Recebida'],
  Recebida: [], // estado terminal
};

const sessionStateMachine = new StateMachine<SessionState>('Sessão', sessionTransitions);

export class SessionStateChangedEvent extends DomainEvent {
  declare readonly fromState: SessionState | null;
  declare readonly toState: SessionState;

  constructor(entityId: string, tenantId: string, fromState: SessionState | null, toState: SessionState) {
    super('SessaoEstadoAlterado', entityId, tenantId, { fromState, toState });
  }
}

/** Uma sessão que já existia (legada, sem desfecho comprovado) passou a ser o item faturável de um desfecho registrado. */
export class SessionBecameBillableEvent extends DomainEvent {
  declare readonly kind: SessionKind;

  constructor(entityId: string, tenantId: string, kind: SessionKind) {
    super('SessaoTornadaElegivel', entityId, tenantId, { kind });
  }
}

export interface SessionProps {
  id: string;
  tenantId: string;
  appointmentId: string;
  patientId: string;
  therapistId: string;
  state: SessionState;
  completedAt?: Date;
  /** Vazio nas sessões legadas, criadas pela confirmação (DP-27). */
  kind?: SessionKind;
  billingEligibility: BillingEligibility;
  voidedAt?: Date;
  voidReason?: SessionVoidReason;
  voidedByUserId?: string;
}

export class Session {
  private _state: SessionState;
  private _pendingEvents: DomainEvent[] = [];

  private constructor(private readonly props: SessionProps) {
    this._state = props.state;
  }

  /**
   * Item faturável novo de um desfecho registrado por pessoa — realização
   * (`atendimento`) ou falta com cobrança confirmada (`falta`). Nasce a
   * faturar e elegível. `completedAt` é o momento em que o desfecho foi
   * registrado.
   */
  static createBillableItem(params: {
    id: string;
    tenantId: string;
    appointmentId: string;
    patientId: string;
    therapistId: string;
    kind: SessionKind;
    at: Date;
  }): Session {
    const session = new Session({
      id: params.id,
      tenantId: params.tenantId,
      appointmentId: params.appointmentId,
      patientId: params.patientId,
      therapistId: params.therapistId,
      state: 'Realizada',
      completedAt: params.at,
      kind: params.kind,
      billingEligibility: 'elegivel',
    });
    session._pendingEvents.push(new SessionStateChangedEvent(params.id, params.tenantId, null, 'Realizada'));
    return session;
  }

  static reconstitute(props: SessionProps): Session {
    return new Session(props);
  }

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get appointmentId(): string {
    return this.props.appointmentId;
  }

  get patientId(): string {
    return this.props.patientId;
  }

  get therapistId(): string {
    return this.props.therapistId;
  }

  get state(): SessionState {
    return this._state;
  }

  get completedAt(): Date | undefined {
    return this.props.completedAt;
  }

  get kind(): SessionKind | undefined {
    return this.props.kind;
  }

  get billingEligibility(): BillingEligibility {
    return this.props.billingEligibility;
  }

  get voidedAt(): Date | undefined {
    return this.props.voidedAt;
  }

  get voidReason(): SessionVoidReason | undefined {
    return this.props.voidReason;
  }

  get voidedByUserId(): string | undefined {
    return this.props.voidedByUserId;
  }

  /** Já entrou numa cobrança (AD-009). */
  get isBilled(): boolean {
    return this._state !== 'Realizada';
  }

  /**
   * Pode entrar numa cobrança nova (ADR-0069, seção 2.9, falha fechada): tem
   * o que cobrar, está elegível, não foi anulada e ainda está a faturar. O
   * paciente e a clínica são conferidos por quem monta a cobrança, e o banco
   * confere tudo de novo pelas chaves compostas.
   */
  get isBillable(): boolean {
    return (
      this.props.kind !== undefined &&
      this.props.billingEligibility === 'elegivel' &&
      this.props.voidedAt === undefined &&
      this._state === 'Realizada'
    );
  }

  /**
   * Reaproveita a sessão que já existia para esta consulta (`appointment_id`
   * é único) como o item faturável do desfecho registrado agora — nunca
   * recria (seção 2.8). É o caso da sessão legada, criada pela confirmação
   * antes da K2-b, ou por uma versão anterior num rollback: ela passa a ser o
   * que a pessoa registrou. Uma anulação é desfeita. Sessão já cobrada não é
   * tocada (quem chama confere antes); outro `kind` já definido é correção de
   * desfecho (T10), fora desta fase.
   */
  makeBillable(kind: SessionKind, at: Date): 'applied' | 'unchanged' {
    if (this.isBilled) {
      throw new Error('Uma sessão já cobrada não muda de item faturável.');
    }
    if (this.isBillable && this.props.kind === kind) {
      return 'unchanged';
    }
    if (this.props.kind !== undefined && this.props.kind !== kind && this.props.voidedAt === undefined) {
      throw new Error(`A sessão já é o item "${this.props.kind}"; trocar o item é correção de desfecho.`);
    }
    this.props.kind = kind;
    this.props.billingEligibility = 'elegivel';
    this.props.completedAt = at;
    this.props.voidedAt = undefined;
    this.props.voidReason = undefined;
    this.props.voidedByUserId = undefined;
    this._pendingEvents.push(new SessionBecameBillableEvent(this.props.id, this.props.tenantId, kind));
    return 'applied';
  }

  transitionTo(newState: SessionState): void {
    sessionStateMachine.assertTransition(this._state, newState);
    const previousState = this._state;
    this._state = newState;
    this._pendingEvents.push(
      new SessionStateChangedEvent(this.props.id, this.props.tenantId, previousState, newState),
    );
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }
}
