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
/**
 * 'individual' e 'completo' — PD-003 (Modelo Comercial), CEO-DEC-002.1:
 * novo catálogo oficial de 2 planos. Existem aqui apenas como ESTRUTURA
 * (Priority 5) — nenhum preço nem benefício foi definido para eles ainda
 * (CEO-DEC-002.3: valores comerciais vivem exclusivamente no Catálogo
 * Comercial Oficial, não no código). `professional`/`business`/`enterprise`
 * permanecem ativos e totalmente funcionais — CEO-DEC-002.6 exige que
 * continuem suportados para clientes já contratados.
 */
export type PlanTier = 'professional' | 'business' | 'enterprise' | 'individual' | 'completo';
export type BillingCycle = 'monthly' | 'yearly';
export type SubscriptionStatus = 'Trialing' | 'Active' | 'PastDue' | 'Cancelled';

/**
 * NOTA DE FIDELIDADE (mesmo padrão do Módulo 02): esta máquina de estados é
 * nova, inferida da documentação de eventos de assinatura da própria Asaas
 * (PAYMENT_CONFIRMED → Active; PAYMENT_OVERDUE → PastDue; assinatura
 * removida → Cancelled).
 *
 * Trialing → PastDue (PD-004, CEO-DEC-003.1): trial sem confirmação de
 * pagamento também entra em PastDue — mesmo tratamento de tolerância que
 * uma falha de cobrança recorrente (CEO-DEC-003.5: a regra de negócio nunca
 * varia por origem ou por meio de pagamento). Nenhum Use Case dispara essa
 * transição automaticamente ainda — depende da duração do trial, que
 * nenhuma decisão aprovada até agora especifica. Ver `pastDueSince` abaixo.
 */
const subscriptionTransitions: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
  Trialing: ['Active', 'PastDue', 'Cancelled'],
  Active: ['PastDue', 'Cancelled'],
  PastDue: ['Active', 'Cancelled'],
  Cancelled: [],
};

/**
 * Período de tolerância/regularização — CEO-DEC-003.1 e CEO-DEC-003.2: 7
 * dias de acesso integral após entrar em PastDue, independentemente da
 * causa (trial não confirmado ou falha de cobrança recorrente) ou do meio
 * de pagamento (CEO-DEC-003.5). Não é um novo estado — PD-004 registra
 * apenas 4 estados nomeados (Trial/?/Suspensa/Cancelada, nomenclatura desta
 * entidade ainda não reconciliada por decisão explícita do CTO) — é uma
 * janela de tempo dentro do próprio PastDue, controlada por `pastDueSince`.
 */
const GRACE_PERIOD_DAYS = 7;

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

export class ClinicSubscriptionPlanChangedEvent extends DomainEvent {
  declare readonly fromPlan: PlanTier;
  declare readonly toPlan: PlanTier;

  constructor(entityId: string, tenantId: string, fromPlan: PlanTier, toPlan: PlanTier) {
    super('AssinaturaPlanoAlterado', entityId, tenantId, { fromPlan, toPlan });
  }
}

export class ClinicSubscriptionDowngradeScheduledEvent extends DomainEvent {
  declare readonly currentPlan: PlanTier;
  declare readonly scheduledPlan: PlanTier;

  constructor(entityId: string, tenantId: string, currentPlan: PlanTier, scheduledPlan: PlanTier) {
    super('AssinaturaDowngradeAgendado', entityId, tenantId, { currentPlan, scheduledPlan });
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
  /** Marco de início do estado PastDue — base do período de tolerância de 7 dias (CEO-DEC-003.1, CEO-DEC-003.2). `undefined` fora de PastDue. */
  pastDueSince?: Date;
  /** Downgrade agendado (CEO-DEC-002.5, CEO-DEC-003.6) — plano que entrará em vigor no próximo ciclo de cobrança. `undefined` quando não há downgrade pendente. */
  pendingPlan?: PlanTier;
}

/**
 * Preços oficiais mensais — fonte: CEO/07 - Planos e precificacao/README.md.
 *
 * BUG REAL ENCONTRADO E CORRIGIDO: enterprise estava em 2990, não 2490.
 * A regra de desconto anual (*12*0.9, ANNUAL_DISCOUNT abaixo) já batia
 * exatamente com o valor anual oficial (R$ 26.892,00/ano) só quando
 * partindo de 2490 — 2990*12*0.9 = 32.292, não o valor documentado.
 *
 * `Partial` deliberado (Priority 5): 'individual'/'completo' não têm
 * entrada aqui — CEO-DEC-002.3 reserva valores comerciais exclusivamente
 * ao Catálogo Comercial Oficial, nunca a este arquivo. `amountPerCycle`
 * abaixo lança erro explícito se chamado para um plano sem preço definido,
 * em vez de inventar ou assumir um valor.
 */
const MONTHLY_PRICE_BRL: Partial<Record<PlanTier, number>> = {
  professional: 597,
  business: 997,
  enterprise: 2490,
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

  get pastDueSince(): Date | undefined {
    return this.props.pastDueSince;
  }

  get pendingPlan(): PlanTier | undefined {
    return this.props.pendingPlan;
  }

  get currentPeriodEnd(): Date | undefined {
    return this.props.currentPeriodEnd;
  }

  /**
   * Valor cobrado por ciclo — já aplicando os 10% de desconto anual
   * oficial. Lança erro explícito para 'individual'/'completo' (Priority
   * 5): estrutura pronta, preço ainda não definido pelo Catálogo Comercial
   * Oficial — nunca assume ou inventa um valor.
   */
  get amountPerCycle(): number {
    const monthly = MONTHLY_PRICE_BRL[this.props.plan];
    if (monthly === undefined) {
      throw new Error(
        `Preço do plano "${this.props.plan}" ainda não configurado no Catálogo Comercial Oficial da Luxora.`,
      );
    }
    if (this.props.billingCycle === 'monthly') return monthly;
    return monthly * 12 * (1 - ANNUAL_DISCOUNT);
  }

  linkToAsaas(asaasCustomerId: string, asaasSubscriptionId: string): void {
    this.props.asaasCustomerId = asaasCustomerId;
    this.props.asaasSubscriptionId = asaasSubscriptionId;
  }

  /**
   * Troca de plano com efeito imediato — usado pelo Upgrade (CEO-DEC-002.5,
   * CEO-DEC-003.6: "aplicada imediatamente, com liberação instantânea dos
   * novos recursos") e, internamente, para aplicar um downgrade já
   * agendado quando o ciclo vigente terminar.
   *
   * A cobrança prorateada da diferença de valor (exigida pela mesma
   * decisão) continua NÃO calculada aqui. `currentPeriodEnd` agora é
   * rastreado (ver `confirmPayment`), então a infraestrutura de onde vem
   * o "período restante do ciclo vigente" já existe — falta apenas o
   * cálculo financeiro em si, que não deve ser estimado com valor
   * fictício. Fica como pendência explícita no Use Case chamador.
   */
  changePlan(newPlan: PlanTier): void {
    const previous = this.props.plan;
    this.props.plan = newPlan;
    this._pendingEvents.push(
      new ClinicSubscriptionPlanChangedEvent(this.props.id, this.props.tenantId, previous, newPlan),
    );
  }

  /**
   * Downgrade — CEO-DEC-002.5, CEO-DEC-003.6: nunca aplicado imediatamente.
   * Fica registrado como `pendingPlan`, para entrar em vigor no início do
   * próximo ciclo de cobrança. Elegibilidade (ex: teto de terapeutas do
   * plano alvo) é responsabilidade de quem chama — esta entidade não
   * conhece `TherapistRepository` nem `PLAN_BENEFITS`.
   */
  scheduleDowngrade(newPlan: PlanTier): void {
    this.props.pendingPlan = newPlan;
    this._pendingEvents.push(
      new ClinicSubscriptionDowngradeScheduledEvent(this.props.id, this.props.tenantId, this.props.plan, newPlan),
    );
  }

  /**
   * Aplica um downgrade previamente agendado — chamado quando o ciclo de
   * cobrança vigente termina. Disparado automaticamente por
   * `confirmPayment()` (ver abaixo), nunca precisa ser chamado
   * diretamente por um Use Case.
   */
  applyPendingDowngrade(): void {
    if (!this.props.pendingPlan) return;
    this.changePlan(this.props.pendingPlan);
    this.props.pendingPlan = undefined;
  }

  /**
   * Confirmação de pagamento (webhook PAYMENT_CONFIRMED/PAYMENT_RECEIVED
   * da Asaas) — cobre dois casos com o mesmo método:
   *
   * 1. Primeira confirmação (Trialing/PastDue → Active).
   * 2. Renovação recorrente de uma assinatura já Active — sem troca de
   *    estado (Active → Active não é uma transição válida na máquina de
   *    estados), só avanço do ciclo.
   *
   * `currentPeriodEnd` é recalculado a partir de `billingCycle` (mensal =
   * +1 mês, anual = +1 ano a partir de agora) — um fato já aprovado do
   * próprio plano contratado pelo cliente, não um valor financeiro
   * inventado. O CÁLCULO do valor cobrado (prorata de upgrade) continua
   * fora do escopo desta entidade.
   *
   * Se havia um downgrade agendado (CEO-DEC-003.6) e a assinatura já
   * tinha um `currentPeriodEnd` anterior (ou seja, esta não é a primeira
   * confirmação, é uma renovação real), o downgrade é aplicado agora —
   * pressuposto: uma nova cobrança confirmada pela Asaas para uma
   * assinatura já Active só acontece no início de um novo ciclo, nunca no
   * meio do ciclo corrente.
   */
  confirmPayment(): void {
    const isRenewal = this._status === 'Active' && this.props.currentPeriodEnd !== undefined;

    if (this._status !== 'Active') {
      this.transitionTo('Active');
    }
    this.props.currentPeriodEnd = this.nextPeriodEnd();

    if (isRenewal && this.props.pendingPlan) {
      this.applyPendingDowngrade();
    }
  }

  private nextPeriodEnd(): Date {
    const next = new Date();
    if (this.props.billingCycle === 'monthly') {
      next.setMonth(next.getMonth() + 1);
    } else {
      next.setFullYear(next.getFullYear() + 1);
    }
    return next;
  }

  transitionTo(newStatus: SubscriptionStatus): void {
    subscriptionStateMachine.assertTransition(this._status, newStatus);
    const previous = this._status;
    this._status = newStatus;
    // CEO-DEC-003.1/003.2: todo ingresso em PastDue reinicia a contagem do
    // período de tolerância; toda saída (regularização ou cancelamento)
    // encerra a janela — não faz sentido preservar `pastDueSince` fora de
    // PastDue.
    this.props.pastDueSince = newStatus === 'PastDue' ? new Date() : undefined;
    this._pendingEvents.push(
      new ClinicSubscriptionStateChangedEvent(this.props.id, this.props.tenantId, previous, newStatus),
    );
  }

  /**
   * Gate de acesso (Módulo 17) — único método que decide se a clínica pode
   * usar a plataforma.
   *
   * PastDue concede acesso integral durante o período de tolerância de 7
   * dias (CEO-DEC-003.1, CEO-DEC-003.2) — depois disso, bloqueia. Um
   * registro em PastDue sem `pastDueSince` (ex: reconstituído de dado
   * legado anterior a esta regra) é tratado como fora do período de
   * tolerância — falha fechado, nunca concede acesso por omissão de dado.
   */
  get hasActiveAccess(): boolean {
    if (this._status === 'Trialing' || this._status === 'Active') return true;
    if (this._status === 'PastDue') return this.isWithinGracePeriod();
    return false;
  }

  private isWithinGracePeriod(): boolean {
    if (!this.props.pastDueSince) return false;
    const elapsedDays = (Date.now() - this.props.pastDueSince.getTime()) / (1000 * 60 * 60 * 24);
    return elapsedDays < GRACE_PERIOD_DAYS;
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }
}
