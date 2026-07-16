import { StateMachine } from '../shared/state-machine';
import { DomainEvent } from '../shared/domain-event';

/**
 * ClinicSubscription — Módulo 17 (ADR-0037).
 *
 * Assinatura DA CLÍNICA COM A LUXORA — nunca confundir com Billing/Payment
 * (Módulo 09), que modelam o PACIENTE pagando a CLÍNICA. Dois domínios
 * financeiros irmãos, nunca a mesma entidade, mesmo compartilhando o Asaas
 * como gateway por baixo.
 */
export type PlanTier = 'professional' | 'business' | 'enterprise';
export type BillingCycle = 'monthly' | 'yearly';
export type SubscriptionStatus = 'Trialing' | 'Active' | 'PastDue' | 'Cancelled';

/**
 * NOTA DE FIDELIDADE (mesmo padrão do Módulo 02): esta máquina de estados é
 * nova, inferida da documentação de eventos de assinatura da própria Asaas
 * (PAYMENT_CONFIRMED → Active; PAYMENT_OVERDUE → PastDue; assinatura
 * removida → Cancelled).
 */
const subscriptionTransitions: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
  Trialing: ['Active', 'Cancelled'],
  Active: ['PastDue', 'Cancelled'],
  PastDue: ['Active', 'Cancelled'],
  Cancelled: [],
};

const subscriptionStateMachine = new StateMachine<SubscriptionStatus>(
  'ClinicSubscription',
  subscriptionTransitions,
);

export class ClinicSubscriptionStateChangedEvent extends DomainEvent {
  declare readonly fromState: SubscriptionStatus;
  declare readonly toState: SubscriptionStatus;

  constructor(entityId: string, tenantId: string, fromState: SubscriptionStatus, toState: SubscriptionStatus) {
    super('AssinaturaEstadoAlterado', entityId, tenantId, { fromState, toState });
  }
}

export interface ClinicSubscriptionProps {
  id: string;
  tenantId: string;
  plan: PlanTier;
  billingCycle: BillingCycle;
  status: SubscriptionStatus;
  asaasCustomerId?: string;
  asaasSubscriptionId?: string;
  currentPeriodEnd?: Date;
}

/** Preços oficiais mensais — fonte: CEO/07 - Planos e precificacao/README.md. */
const MONTHLY_PRICE_BRL: Record<PlanTier, number> = {
  professional: 597,
  business: 997,
  enterprise: 2990,
};
const ANNUAL_DISCOUNT = 0.1;

export class ClinicSubscription {
  private _status: SubscriptionStatus;
  private _pendingEvents: DomainEvent[] = [];

  private constructor(private readonly props: ClinicSubscriptionProps) {
    this._status = props.status;
  }

  static create(props: Omit<ClinicSubscriptionProps, 'status'>): ClinicSubscription {
    return new ClinicSubscription({ ...props, status: 'Trialing' });
  }

  static reconstitute(props: ClinicSubscriptionProps): ClinicSubscription {
    return new ClinicSubscription(props);
  }

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get plan(): PlanTier {
    return this.props.plan;
  }

  get billingCycle(): BillingCycle {
    return this.props.billingCycle;
  }

  get status(): SubscriptionStatus {
    return this._status;
  }

  get asaasCustomerId(): string | undefined {
    return this.props.asaasCustomerId;
  }

  get asaasSubscriptionId(): string | undefined {
    return this.props.asaasSubscriptionId;
  }

  /** Valor cobrado por ciclo — já aplicando os 10% de desconto anual oficial. */
  get amountPerCycle(): number {
    const monthly = MONTHLY_PRICE_BRL[this.props.plan];
    if (this.props.billingCycle === 'monthly') return monthly;
    return monthly * 12 * (1 - ANNUAL_DISCOUNT);
  }

  linkToAsaas(asaasCustomerId: string, asaasSubscriptionId: string): void {
    this.props.asaasCustomerId = asaasCustomerId;
    this.props.asaasSubscriptionId = asaasSubscriptionId;
  }

  transitionTo(newStatus: SubscriptionStatus): void {
    subscriptionStateMachine.assertTransition(this._status, newStatus);
    const previous = this._status;
    this._status = newStatus;
    this._pendingEvents.push(
      new ClinicSubscriptionStateChangedEvent(this.props.id, this.props.tenantId, previous, newStatus),
    );
  }

  /** Gate de acesso (Módulo 17) — único método que decide se a clínica pode usar a plataforma. */
  get hasActiveAccess(): boolean {
    return this._status === 'Trialing' || this._status === 'Active';
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }
}
