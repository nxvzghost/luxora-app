import { StateMachine } from '../shared/state-machine';
import { DomainEvent } from '../shared/domain-event';

/**
 * Estados da Cobrança.
 * Fonte: docs/01-Domain/03-Maquina-de-Estados.md, seção "Cobrança".
 */
export type BillingState =
  | 'Criada'
  | 'Enviada'
  | 'Visualizada'
  | 'Pendente'
  | 'Atrasada'
  | 'Negociada'
  | 'Escalada'
  | 'Quitada'
  | 'Cancelada';

/**
 * NOTA DE FIDELIDADE: transições inferidas a partir do fluxo financeiro
 * documentado (docs/06-UX/04-Fluxo-Financeiro.md, docs/05-IA/03-Gestao-de-
 * Inadimplencia.md — limiares de 7 e 40 dias) — o documento de origem lista
 * apenas os estados possíveis, não a tabela de transição.
 */
const billingTransitions: Record<BillingState, readonly BillingState[]> = {
  Criada: ['Enviada', 'Cancelada'],
  Enviada: ['Visualizada', 'Pendente', 'Cancelada'],
  Visualizada: ['Pendente', 'Quitada', 'Cancelada'],
  Pendente: ['Quitada', 'Atrasada', 'Cancelada'],
  Atrasada: ['Negociada', 'Escalada', 'Quitada'], // nunca "Cancelada" direto de Atrasada — decisão humana obrigatória (ver Gestão de Inadimplência)
  Negociada: ['Pendente', 'Quitada'],
  Escalada: ['Negociada', 'Quitada'],
  Quitada: [], // estado terminal
  Cancelada: [], // estado terminal
};

const billingStateMachine = new StateMachine<BillingState>('Cobrança', billingTransitions);

export class BillingStateChangedEvent extends DomainEvent {
  declare readonly fromState: BillingState;
  declare readonly toState: BillingState;

  constructor(entityId: string, tenantId: string, fromState: BillingState, toState: BillingState) {
    super('CobrancaEstadoAlterado', entityId, tenantId, { fromState, toState });
  }
}

export interface BillingProps {
  id: string;
  tenantId: string;
  patientId: string;
  amount: number;
  dueDate: Date;
  state: BillingState;
}

export class Billing {
  private _state: BillingState;
  private _pendingEvents: DomainEvent[] = [];

  private constructor(private readonly props: BillingProps) {
    this._state = props.state;
  }

  static create(props: Omit<BillingProps, 'state'>): Billing {
    if (props.amount <= 0) {
      throw new Error('Cobrança não pode ter valor menor ou igual a zero.');
    }
    return new Billing({ ...props, state: 'Criada' });
  }

  static reconstitute(props: BillingProps): Billing {
    return new Billing(props);
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

  get amount(): number {
    return this.props.amount;
  }

  get dueDate(): Date {
    return this.props.dueDate;
  }

  get state(): BillingState {
    return this._state;
  }

  /**
   * Dias em atraso a partir do vencimento — base para a classificação
   * em_atraso (≤7 dias) / inadimplente (>40 dias), ver
   * docs/05-IA/03-Gestao-de-Inadimplencia.md.
   */
  daysOverdue(referenceDate: Date = new Date()): number {
    const diffMs = referenceDate.getTime() - this.props.dueDate.getTime();
    return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
  }

  transitionTo(newState: BillingState): void {
    billingStateMachine.assertTransition(this._state, newState);
    const previousState = this._state;
    this._state = newState;
    this._pendingEvents.push(
      new BillingStateChangedEvent(this.props.id, this.props.tenantId, previousState, newState),
    );
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }
}
