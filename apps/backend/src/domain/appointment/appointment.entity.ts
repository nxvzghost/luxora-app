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
  // A realização e a falta não são estados de agenda: são desfechos, em
  // appointment-outcome.ts (K2-b, ADR-0069 seção 2.4). Confirmar não cria sessão.
  Confirmada: ['ReagendamentoSolicitado', 'Cancelada'],
  // ReagendamentoSolicitado e Reagendada só existem em consultas legadas: desde a
  // K2-b a remarcação cria uma ocorrência nova (Appointment.rescheduledFrom).
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

/** K2-b — a ocorrência nova de uma remarcação; o evento da anterior está no desfecho (appointment-outcome.ts). */
export class AppointmentCreatedByRescheduleEvent extends DomainEvent {
  declare readonly previousAppointmentId: string;

  constructor(entityId: string, tenantId: string, previousAppointmentId: string) {
    super('ConsultaRemarcada', entityId, tenantId, { previousAppointmentId });
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
  /**
   * Referência ao RecurringBlock de origem — PD-001 Fase 2, C3. Preenchido
   * só para ocorrências materializadas (ver
   * MaterializarRecurringBlockUseCase); ausente para Appointments avulsos e
   * para os criados por CriarAgendamentoRecorrenteUseCase (que não foi
   * alterado nesta etapa). Puramente aditivo — nenhum comportamento
   * existente de Appointment muda por causa deste campo.
   */
  recurringBlockId?: string;
  /**
   * K2-b (ADR-0069, seção 5) — ocorrência anterior, quando esta nasceu de uma
   * remarcação. A remarcação não move mais o horário da mesma linha: encerra
   * a ocorrência e cria esta, ligada a ela.
   */
  rescheduledFromId?: string;
}

/**
 * Estados de agenda em que a consulta ainda pode receber um desfecho de
 * atendimento (realização, falta) ou ser cancelada e remarcada pela versão
 * atual — ADR-0069, seção 2.5 (T3 a T7).
 */
export const OPEN_APPOINTMENT_STATES: readonly AppointmentState[] = ['Reservada', 'Confirmada', 'Reagendada'];

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

  /**
   * K2-b — a nova ocorrência de uma remarcação (T5): mesmo paciente,
   * terapeuta e modalidade, no horário novo, já `Reservada`, ligada à
   * anterior. Não herda o horário fixo de origem: a anterior mantém a chave
   * de materialização (recurringBlockId, scheduledAt), e a cadeia de
   * remarcações é quem liga as duas (achado 3 da ADR-0069).
   */
  static rescheduledFrom(previous: Appointment, params: { id: string; scheduledAt: Date }): Appointment {
    const next = Appointment.create({
      id: params.id,
      tenantId: previous.tenantId,
      patientId: previous.patientId,
      therapistId: previous.therapistId,
      scheduledAt: params.scheduledAt,
      modality: previous.modality,
      recurring: previous.isRecurring,
      rescheduledFromId: previous.id,
    });
    next.transitionTo('Reservada');
    next._pendingEvents.push(new AppointmentCreatedByRescheduleEvent(next.id, next.tenantId, previous.id));
    return next;
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

  get modality(): 'presencial' | 'online' {
    return this.props.modality;
  }

  get state(): AppointmentState {
    return this._state;
  }

  get isRecurring(): boolean {
    return this.props.recurring;
  }

  get recurringBlockId(): string | undefined {
    return this.props.recurringBlockId;
  }

  get rescheduledFromId(): string | undefined {
    return this.props.rescheduledFromId;
  }

  /** O início previsto já chegou? No instante do início, sim (ADR-0069, seção 2.2). */
  hasStarted(now: Date): boolean {
    return now.getTime() >= this.props.scheduledAt.getTime();
  }

  /** Em estado de agenda que ainda aceita desfecho, cancelamento ou remarcação (seção 2.5). */
  get isOpen(): boolean {
    return OPEN_APPOINTMENT_STATES.includes(this._state);
  }

  transitionTo(newState: AppointmentState): void {
    appointmentStateMachine.assertTransition(this._state, newState);
    const previousState = this._state;
    this._state = newState;
    this._pendingEvents.push(
      new AppointmentStateChangedEvent(this.props.id, this.props.tenantId, previousState, newState),
    );
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }
}
