import { StateMachine } from '../shared/state-machine';
import { DomainEvent } from '../shared/domain-event';

/**
 * Estados da Sessão (atendimento em si — distinto do Agendamento/reserva).
 *
 * Fonte: docs/01-Domain/03-Maquina-de-Estados.md, seção "Sessão", subconjunto
 * final; resolvido em docs/01-Domain/05-Linguagem-Ubiqua.md.
 *
 * Uma Sessão só é criada a partir de um Appointment em estado "Confirmada"
 * — ver Session.createFromConfirmedAppointment.
 */
export type SessionState = 'Realizada' | 'Faturada' | 'Recebida';

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

export interface SessionProps {
  id: string;
  tenantId: string;
  appointmentId: string;
  patientId: string;
  therapistId: string;
  state: SessionState;
  completedAt?: Date;
}

export class Session {
  private _state: SessionState;
  private _pendingEvents: DomainEvent[] = [];

  private constructor(private readonly props: SessionProps) {
    this._state = props.state;
  }

  /**
   * Único ponto de criação de uma Sessão — exige um Appointment confirmado,
   * reforçando a regra de que atendimento nunca existe sem reserva prévia.
   */
  static createFromConfirmedAppointment(params: {
    id: string;
    tenantId: string;
    appointmentId: string;
    appointmentState: string;
    patientId: string;
    therapistId: string;
  }): Session {
    if (params.appointmentState !== 'Confirmada') {
      throw new Error(
        'Uma Sessão só pode ser criada a partir de um Agendamento em estado "Confirmada".',
      );
    }
    const session = new Session({
      id: params.id,
      tenantId: params.tenantId,
      appointmentId: params.appointmentId,
      patientId: params.patientId,
      therapistId: params.therapistId,
      state: 'Realizada',
      completedAt: new Date(),
    });
    session._pendingEvents.push(
      new SessionStateChangedEvent(params.id, params.tenantId, null, 'Realizada'),
    );
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

  get state(): SessionState {
    return this._state;
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
