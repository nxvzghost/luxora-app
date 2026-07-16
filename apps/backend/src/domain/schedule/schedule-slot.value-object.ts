import { StateMachine } from '../shared/state-machine';

/**
 * Estados do Horário (slot da agenda do terapeuta).
 * Fonte: docs/01-Domain/03-Maquina-de-Estados.md, seção "Horário".
 *
 * Diferente de Patient/Appointment/Session/Billing/Payment, "Horário" é
 * modelado como Value Object, não como entidade com identidade própria e
 * persistência direta — ele representa a disponibilidade em um ponto no
 * tempo, derivada de Appointments e bloqueios manuais, consumida pelo Caso
 * de Uso ConsultarDisponibilidade (docs/04-API/01-Contratos-REST.md).
 * Não gera DomainEvent próprio — mudanças de disponibilidade são reflexo de
 * eventos de Appointment (AgendamentoEstadoAlterado) ou de bloqueio manual.
 */
export type ScheduleSlotState = 'Livre' | 'Reservado' | 'Confirmado' | 'Bloqueado' | 'Indisponivel';

const scheduleSlotTransitions: Record<ScheduleSlotState, readonly ScheduleSlotState[]> = {
  Livre: ['Reservado', 'Bloqueado', 'Indisponivel'],
  Reservado: ['Confirmado', 'Livre'],
  Confirmado: ['Livre'], // cancelamento libera o horário de volta
  Bloqueado: ['Livre'],
  Indisponivel: ['Livre'], // mudança de configuração de expediente
};

const scheduleSlotStateMachine = new StateMachine<ScheduleSlotState>(
  'Horário',
  scheduleSlotTransitions,
);

export class ScheduleSlot {
  private constructor(
    readonly therapistId: string,
    readonly startsAt: Date,
    readonly endsAt: Date,
    private _state: ScheduleSlotState,
  ) {}

  static free(therapistId: string, startsAt: Date, endsAt: Date): ScheduleSlot {
    if (startsAt >= endsAt) {
      throw new Error('Horário inválido: início deve ser anterior ao fim.');
    }
    return new ScheduleSlot(therapistId, startsAt, endsAt, 'Livre');
  }

  get state(): ScheduleSlotState {
    return this._state;
  }

  get isAvailable(): boolean {
    return this._state === 'Livre';
  }

  /**
   * Detecta sobreposição com outro slot — base do teste crítico #10
   * (conflito de agenda concorrente), docs/09-Testes/01-Testes-Criticos.md.
   */
  overlapsWith(other: ScheduleSlot): boolean {
    return this.startsAt < other.endsAt && other.startsAt < this.endsAt;
  }

  transitionTo(newState: ScheduleSlotState): void {
    scheduleSlotStateMachine.assertTransition(this._state, newState);
    this._state = newState;
  }
}
