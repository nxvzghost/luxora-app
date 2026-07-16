import { StateMachine } from '../shared/state-machine';
import { DomainEvent } from '../shared/domain-event';

/**
 * Estados do Agendamento (reserva de horário).
 *
 * Fonte: docs/01-Domain/03-Maquina-de-Estados.md, seção "Sessão", subconjunto
 * inicial — resolvido em docs/01-Domain/05-Linguagem-Ubiqua.md: "appointment"
 * representa a reserva de horário (estados iniciais), "session" representa o
 * atendimento em si (estados finais: Realizada, Faturada, Recebida — ver
 * session.entity.ts).
 */
export type AppointmentState =
  | 'Criada'
  | 'Reservada'
  | 'Confirmada'
  | 'ReagendamentoSolicitado'
  | 'Reagendada'
  | 'Cancelada';

const appointmentTransitions: Record<AppointmentState, readonly AppointmentState[]> = {
  Criada: ['Reservada', 'Cancelada'],
  Reservada: ['Confirmada', 'ReagendamentoSolicitado', 'Cancelada'],
  Confirmada: ['ReagendamentoSolicitado', 'Cancelada'], // transição para "Realizada" pertence à entidade Session
  ReagendamentoSolicitado: ['Reagendada', 'Cancelada'],
  Reagendada: ['Confirmada', 'ReagendamentoSolicitado', 'Cancelada'],
  Cancelada: [], // estado terminal
};

const appointmentStateMachine = new StateMachine<AppointmentState>(
  'Agendamento',
  appointmentTransitions,
);

export class AppointmentStateChangedEvent extends DomainEvent {
  declare readonly fromState: AppointmentState;
  declare readonly toState: AppointmentState;

  constructor(entityId: string, tenantId: string, fromState: AppointmentState, toState: AppointmentState) {
    super('AgendamentoEstadoAlterado', entityId, tenantId, { fromState, toState });
  }
}

export interface AppointmentProps {
  id: string;
  tenantId: string;
  patientId: string;
  therapistId: string;
  scheduledAt: Date;
  modality: 'presencial' | 'online';
  state: AppointmentState;
  recurring: boolean;
}

export class Appointment {
  private _state: AppointmentState;
  private _pendingEvents: DomainEvent[] = [];

  private constructor(private readonly props: AppointmentProps) {
    this._state = props.state;
  }

  static create(props: Omit<AppointmentProps, 'state'>): Appointment {
    return new Appointment({ ...props, state: 'Criada' });
  }

  static reconstitute(props: AppointmentProps): Appointment {
    return new Appointment(props);
  }

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get patientId(): string {
    return this.props.patientId;
  }

  get therapistId(): string {
    return this.props.therapistId;
  }

  get scheduledAt(): Date {
    return this.props.scheduledAt;
  }

  get state(): AppointmentState {
    return this._state;
  }

  get isRecurring(): boolean {
    return this.props.recurring;
  }

  transitionTo(newState: AppointmentState): void {
    appointmentStateMachine.assertTransition(this._state, newState);
    const previousState = this._state;
    this._state = newState;
    this._pendingEvents.push(
      new AppointmentStateChangedEvent(this.props.id, this.props.tenantId, previousState, newState),
    );
  }

  /**
   * Reagenda o horário — RF-052. Só é permitido a partir de estados que
   * já passaram pelo pedido de reagendamento (regra de negócio, não apenas
   * de máquina de estados: mudar a data exige primeiro pedir o reagendamento).
   */
  reschedule(newScheduledAt: Date): void {
    if (this._state !== 'ReagendamentoSolicitado') {
      throw new Error(
        `Não é possível reagendar a partir do estado "${this._state}" — solicite o reagendamento primeiro.`,
      );
    }
    this.props.scheduledAt = newScheduledAt;
    this.transitionTo('Reagendada');
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }
}
