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
  // Quitada a partir de Criada: um pagamento pode ser registrado antes de
  // qualquer envio de cobrança (ex: paciente paga em mãos/PIX direto no
  // consultório) — RegistrarPagamentoUseCase quita a Billing sempre que o
  // Payment confirma, independente de em qual estado de comunicação ela
  // estava. Bug real encontrado: todo outro estado não-terminal já tinha
  // caminho até Quitada, só Criada não — descoberto ao rodar o Teste
  // Crítico #8 (idempotência de pagamento) contra o banco real pela
  // primeira vez.
  Criada: ['Enviada', 'Quitada', 'Cancelada'],
  // Tarefa 05 da auditoria — "Quitada" a partir de Enviada. É o caminho que
  // a clínica percorre pela tela: gera a cobrança, envia ao paciente e
  // registra o pagamento quando ele chega. Sem esta transição, a regra do
  // comentário acima não valia justamente para o caso mais comum: POST
  // /payments respondia 500 e, como o pagamento já tinha sido gravado, a
  // cobrança nunca mais podia ser quitada (ver
  // test/critical/billing-sent-then-paid.test.ts).
  Enviada: ['Visualizada', 'Pendente', 'Quitada', 'Cancelada'],
  Visualizada: ['Pendente', 'Quitada', 'Cancelada'],
  Pendente: ['Quitada', 'Atrasada', 'Cancelada'],
  Atrasada: ['Negociada', 'Escalada', 'Quitada'], // nunca "Cancelada" direto de Atrasada — decisão humana obrigatória (ver Gestão de Inadimplência)
  Negociada: ['Pendente', 'Quitada'],
  Escalada: ['Negociada', 'Quitada'],
  Quitada: [], // estado terminal
  Cancelada: [], // estado terminal
};

const billingStateMachine = new StateMachine<BillingState>('Cobrança', billingTransitions);

/**
 * Estados em que a cobrança ainda aguarda pagamento e não entrou no
 * tratamento de atraso (`Atrasada`, `Negociada`, `Escalada`). É neles que o
 * vencimento, sozinho, decide se a cobrança está em atraso — ver isOverdue().
 */
export const AWAITING_PAYMENT_STATES: readonly BillingState[] = ['Criada', 'Enviada', 'Visualizada', 'Pendente'];

const DAY_IN_MS = 24 * 60 * 60 * 1000;

/**
 * Vencimento mais recente que já conta como atraso em `referenceDate`: um
 * dia inteiro depois do vencimento, a mesma régua de daysOverdue() (D+1 é o
 * primeiro dia de atraso). Exportado para a contagem no banco usar
 * exatamente o mesmo corte que isOverdue().
 */
export function overdueDueDateCutoff(referenceDate: Date): Date {
  return new Date(referenceDate.getTime() - DAY_IN_MS);
}

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

  /**
   * Em atraso — Tarefa 05 da auditoria (ADR-0061).
   *
   * ACHADO REAL: os indicadores "cobranças em atraso" contavam só o estado
   * `Atrasada`, e nenhum fluxo leva uma cobrança até ele. O contador ficava
   * em zero para sempre, mesmo com cobranças vencidas.
   *
   * A regra passa a ser calculada, sem transição nova:
   * - `Atrasada` continua em atraso, como já era;
   * - `Criada`, `Enviada`, `Visualizada` e `Pendente` estão em atraso quando
   *   o vencimento passou há um dia inteiro ou mais (daysOverdue() >= 1);
   * - `Quitada` e `Cancelada` nunca estão; `Negociada` e `Escalada` seguem
   *   fora da contagem, como já estavam.
   *
   * O estado gravado não muda: uma cobrança `Enviada` e vencida continua
   * `Enviada`. Sem vencimento válido, não há atraso por data.
   */
  isOverdue(referenceDate: Date = new Date()): boolean {
    if (this._state === 'Atrasada') return true;
    if (!AWAITING_PAYMENT_STATES.includes(this._state)) return false;
    const dueTime = this.props.dueDate instanceof Date ? this.props.dueDate.getTime() : Number.NaN;
    if (Number.isNaN(dueTime)) return false;
    return dueTime <= overdueDueDateCutoff(referenceDate).getTime();
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
