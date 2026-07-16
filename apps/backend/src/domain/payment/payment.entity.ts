import { StateMachine } from '../shared/state-machine';
import { DomainEvent } from '../shared/domain-event';

/**
 * Estados do Pagamento.
 * Fonte: docs/01-Domain/03-Maquina-de-Estados.md, seção "Pagamento".
 */
export type PaymentState = 'Recebido' | 'EmConferencia' | 'Confirmado' | 'Divergente' | 'Estornado';

const paymentTransitions: Record<PaymentState, readonly PaymentState[]> = {
  // reconcile() (abaixo) transiciona direto de Recebido para Confirmado/Divergente —
  // é o único fluxo de reconciliação implementado neste MVP, automático e síncrono.
  // EmConferencia permanece como estado documentado (03-Maquina-de-Estados.md) para
  // um fluxo de conferência manual futuro, ainda não implementado por nenhum caller.
  Recebido: ['EmConferencia', 'Confirmado', 'Divergente'],
  EmConferencia: ['Confirmado', 'Divergente'],
  Divergente: ['EmConferencia', 'Confirmado'], // re-conferência pode resolver a divergência
  Confirmado: ['Estornado'],
  Estornado: [], // estado terminal
};

const paymentStateMachine = new StateMachine<PaymentState>('Pagamento', paymentTransitions);

export class PaymentStateChangedEvent extends DomainEvent {
  declare readonly fromState: PaymentState;
  declare readonly toState: PaymentState;

  constructor(entityId: string, tenantId: string, fromState: PaymentState, toState: PaymentState) {
    super('PagamentoEstadoAlterado', entityId, tenantId, { fromState, toState });
  }
}

export interface PaymentProps {
  id: string;
  tenantId: string;
  billingId: string;
  amount: number;
  method: string;
  idempotencyKey: string;
  state: PaymentState;
}

/**
 * Entidade Pagamento — a idempotencyKey é obrigatória na criação, refletindo
 * RNF-008 ("nunca registrar pagamentos duplicados") e o teste crítico #8
 * (docs/09-Testes/01-Testes-Criticos.md).
 */
export class Payment {
  private _state: PaymentState;
  private _pendingEvents: DomainEvent[] = [];

  private constructor(private readonly props: PaymentProps) {
    this._state = props.state;
  }

  static create(props: Omit<PaymentProps, 'state'>): Payment {
    if (!props.idempotencyKey) {
      throw new Error('Pagamento não pode ser criado sem idempotencyKey (RNF-008).');
    }
    if (props.amount <= 0) {
      throw new Error('Pagamento não pode ter valor menor ou igual a zero.');
    }
    return new Payment({ ...props, state: 'Recebido' });
  }

  static reconstitute(props: PaymentProps): Payment {
    return new Payment(props);
  }

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get billingId(): string {
    return this.props.billingId;
  }

  get amount(): number {
    return this.props.amount;
  }

  get idempotencyKey(): string {
    return this.props.idempotencyKey;
  }

  get state(): PaymentState {
    return this._state;
  }

  /**
   * Confirma o pagamento apenas se o valor recebido confere com o esperado —
   * caso contrário, transiciona para Divergente em vez de Confirmado
   * (nunca decide "aceitar mesmo assim" sozinha — Princípio 03).
   */
  reconcile(expectedAmount: number): void {
    if (Math.abs(this.props.amount - expectedAmount) > 0.01) {
      this.transitionTo('Divergente');
      return;
    }
    this.transitionTo('Confirmado');
  }

  transitionTo(newState: PaymentState): void {
    paymentStateMachine.assertTransition(this._state, newState);
    const previousState = this._state;
    this._state = newState;
    this._pendingEvents.push(
      new PaymentStateChangedEvent(this.props.id, this.props.tenantId, previousState, newState),
    );
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }
}
