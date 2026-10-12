import { StateMachine } from '../shared/state-machine';
import { DomainEvent } from '../shared/domain-event';
import { civilDateIn, civilDateOfDateOnly, civilDayNumber } from '../shared/time-zone';

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

/**
 * Vencimento e atraso — AD-039 (ADR-0064).
 *
 * O vencimento é uma DATA, sem hora: o dia do calendário escrito na cobrança
 * (a API o recebe como `AAAA-MM-DD` e o guarda como a meia-noite UTC desse
 * dia — ver civilDateOfDateOnly). A cobrança continua em dia durante todo o
 * dia do vencimento, no fuso da clínica, e passa a estar em atraso à
 * meia-noite do dia seguinte, também no fuso da clínica. Nada aqui depende
 * do fuso do processo.
 *
 * `overdueDueDateLimit` é o corte em forma de instante, para a contagem no
 * banco usar exatamente a regra de isOverdue(): está em atraso a cobrança
 * cujo vencimento gravado é ANTERIOR à meia-noite UTC do dia que é "hoje" na
 * clínica. Com a clínica em São Paulo às 23:59 do dia 12, "hoje" é 12 e só
 * os vencimentos até o dia 11 contam; um minuto depois, "hoje" é 13 e o dia
 * 12 passa a contar.
 */
export function overdueDueDateLimit(timeZone: string, referenceDate: Date): Date {
  const today = civilDateIn(referenceDate, timeZone);
  return new Date(Date.UTC(today.year, today.month - 1, today.day));
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
   *
   * AD-039 — dias do calendário da clínica (`timeZone`), não blocos de 24 h
   * a partir da meia-noite UTC: 0 até o fim do dia do vencimento, 1 a partir
   * da meia-noite seguinte na clínica, e assim por diante.
   */
  daysOverdue(timeZone: string, referenceDate: Date = new Date()): number {
    const dueDay = civilDayNumber(civilDateOfDateOnly(this.props.dueDate));
    const today = civilDayNumber(civilDateIn(referenceDate, timeZone));
    return Math.max(0, today - dueDay);
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
   * - `Criada`, `Enviada`, `Visualizada` e `Pendente` estão em atraso a
   *   partir da meia-noite do dia seguinte ao vencimento, no fuso da clínica
   *   (daysOverdue() >= 1) — AD-039: antes o corte era em UTC, e a cobrança
   *   constava em atraso às 21h de Brasília do próprio dia do vencimento;
   * - `Quitada` e `Cancelada` nunca estão; `Negociada` e `Escalada` seguem
   *   fora da contagem, como já estavam.
   *
   * O estado gravado não muda: uma cobrança `Enviada` e vencida continua
   * `Enviada`. Sem vencimento válido, não há atraso por data.
   */
  isOverdue(timeZone: string, referenceDate: Date = new Date()): boolean {
    if (this._state === 'Atrasada') return true;
    if (!AWAITING_PAYMENT_STATES.includes(this._state)) return false;
    const dueTime = this.props.dueDate instanceof Date ? this.props.dueDate.getTime() : Number.NaN;
    if (Number.isNaN(dueTime)) return false;
    return dueTime < overdueDueDateLimit(timeZone, referenceDate).getTime();
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
