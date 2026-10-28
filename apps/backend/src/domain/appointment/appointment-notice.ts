import { DomainEvent } from '../shared/domain-event';
import type { Appointment } from './appointment.entity';

/**
 * Comunicação do paciente sobre uma consulta — K2-b (ADR-0069, seções 2.2,
 * 2.3 e 3.2; DP-25, DP-26).
 *
 * Um fato registrado, somente acréscimo: diz o que foi comunicado, quando e
 * por quem. Registrar uma comunicação não muda a consulta nem decide nada;
 * quem decide é o caso de uso que a usa para encerrar a consulta
 * (cancelamento ou remarcação) ou, nas fases seguintes, uma pessoa.
 *
 * O painel grava a comunicação do cancelamento e da remarcação. Pelo WhatsApp
 * (K11, D2), a IA grava o pedido de cancelamento ou remarcação e, em outra
 * linha, a resposta do paciente à pergunta de confirmação; o estado do
 * pedido é derivado delas (appointment-request.ts). O carimbo da Meta ainda
 * não é lido (K13): a referência pelo WhatsApp é o recebimento no webhook.
 */
export type NoticeTiming = 'no_prazo' | 'fora_do_prazo' | 'sem_limite_configurado' | 'depois_do_inicio';
export type NoticeIntent = 'nao_comparecera' | 'atraso' | 'pedido_cancelamento' | 'pedido_remarcacao' | 'indefinida';
export type NoticeRequestedBy = 'paciente' | 'clinica' | 'profissional';
export type NoticeChannel = 'whatsapp' | 'painel';
export type NoticeReferenceSource = 'meta_timestamp' | 'recebimento_webhook' | 'registro_no_painel';
export type NoticeReviewStatus = 'pendente' | 'revisada' | 'sem_revisao_necessaria';
/** K11 — o que o paciente respondeu à pergunta de confirmação. Só `confirma` leva ao desfecho. */
export type NoticeConfirmationAnswer = 'confirma' | 'recusa' | 'ambigua';
/** K11 — o que o pedido feito pelo WhatsApp quer fazer com a consulta. */
export type NoticeRequestedAction = 'cancelar' | 'remarcar';
/** K11 — intenções que abrem um pedido; "não vou conseguir ir" antes do início é pedido de cancelamento (D7). */
export type RequestIntent = 'pedido_cancelamento' | 'pedido_remarcacao' | 'nao_comparecera';

export const NOTICE_REQUESTERS: readonly NoticeRequestedBy[] = ['paciente', 'clinica', 'profissional'];
/** Limite do motivo livre: fora da auditoria e da IA (ADR-0069, seção 2.10). */
export const NOTICE_REASON_MAX_LENGTH = 200;

export interface NoticeClassification {
  timing: NoticeTiming;
  /** Positivo antes do início; zero ou negativo no início e depois. */
  minutesFromStart: number;
  /** O limite da clínica usado na classificação, só quando houve limite e o aviso veio antes do início. */
  limitHoursApplied?: number;
}

/**
 * Classifica o momento de uma comunicação pelo horário de referência e pelo
 * início previsto (seção 2.2). No instante do início, ou depois, é sempre
 * `depois_do_inicio`, sem limite final (DP-26, rodada 2). Antes do início,
 * a antecedência é comparada com o limite da clínica: maior ou igual a ele é
 * `no_prazo`. Classificar não é decidir.
 */
export function classifyNoticeTiming(referenceTime: Date, scheduledAt: Date, limitHours?: number | null): NoticeClassification {
  const millisecondsBefore = scheduledAt.getTime() - referenceTime.getTime();
  // Arredondado para cima: qualquer instante antes do início dá ao menos 1
  // minuto, e o início em diante dá zero ou menos — o mesmo corte do timing.
  const minutesFromStart = Math.ceil(millisecondsBefore / 60_000) || 0;
  if (millisecondsBefore <= 0) {
    return { timing: 'depois_do_inicio', minutesFromStart };
  }
  if (limitHours === undefined || limitHours === null) {
    return { timing: 'sem_limite_configurado', minutesFromStart };
  }
  const hoursBefore = millisecondsBefore / 3_600_000;
  return { timing: hoursBefore >= limitHours ? 'no_prazo' : 'fora_do_prazo', minutesFromStart, limitHoursApplied: limitHours };
}

export interface AppointmentNoticeProps {
  id: string;
  tenantId: string;
  appointmentId: string;
  patientId: string;
  channel: NoticeChannel;
  recordedAt: Date;
  referenceTime: Date;
  referenceSource: NoticeReferenceSource;
  classification: NoticeClassification;
  intent: NoticeIntent;
  intentSource: 'ia' | 'pessoa';
  requestedBy?: NoticeRequestedBy;
  recordedByUserId?: string;
  recordedByActorType: 'user' | 'ai_agent' | 'system';
  reason?: string;
  reviewStatus: NoticeReviewStatus;
  /** K11 — a mensagem do WhatsApp (identificador da Meta) e quando ela chegou ao webhook. */
  messageId?: string;
  receivedAt?: Date;
  conversationId?: string;
  /** K11 — pedido que aguarda a confirmação do paciente, com o retrato da consulta perguntada. */
  awaitsConfirmation?: boolean;
  requestedAction?: NoticeRequestedAction;
  askedScheduledAt?: Date;
  askedModality?: string;
  proposedScheduledAt?: Date;
  /** K11 — resposta a um pedido. */
  confirmsNoticeId?: string;
  confirmationAnswer?: NoticeConfirmationAnswer;
}

export class NoticeRecordedEvent extends DomainEvent {
  declare readonly appointmentId: string;
  declare readonly channel: NoticeChannel;
  declare readonly intent: NoticeIntent;
  declare readonly timing: NoticeTiming;
  declare readonly requestedBy: NoticeRequestedBy | null;
  declare readonly requestedAction: NoticeRequestedAction | null;
  declare readonly confirmsNoticeId: string | null;
  declare readonly confirmationAnswer: NoticeConfirmationAnswer | null;

  constructor(notice: AppointmentNotice) {
    // O motivo livre e o texto da mensagem não entram na auditoria (seção 2.10).
    super('ComunicacaoRegistrada', notice.id, notice.tenantId, {
      appointmentId: notice.appointmentId,
      channel: notice.channel,
      intent: notice.intent,
      timing: notice.timing,
      requestedBy: notice.requestedBy ?? null,
      requestedAction: notice.requestedAction ?? null,
      confirmsNoticeId: notice.confirmsNoticeId ?? null,
      confirmationAnswer: notice.confirmationAnswer ?? null,
    });
  }
}

/** Mensagem do WhatsApp que vira comunicação (K11). */
export interface WhatsAppMessageRef {
  conversationId: string;
  /** Identificador da Meta (WAMID): uma comunicação por mensagem (message_id único). */
  messageId: string;
  /** Quando o Vertex recebeu a mensagem no webhook: a referência da classificação (K13 ainda não lê o carimbo da Meta). */
  receivedAt: Date;
}

export class AppointmentNotice {
  private _pendingEvents: DomainEvent[] = [];

  private constructor(private readonly props: AppointmentNoticeProps) {}

  /**
   * Comunicação registrada por uma pessoa no painel, no ato de cancelar ou
   * remarcar (N1, canal `painel`, F5c). O horário de referência é o do
   * registro: o painel não tem horário de recebimento comprovado. Quem pediu
   * fica registrado à parte de quem registrou (DP-25).
   */
  static recordFromPanel(params: {
    id: string;
    appointment: Appointment;
    intent: NoticeIntent;
    requestedBy: NoticeRequestedBy;
    reason?: string;
    recordedByUserId: string;
    now: Date;
    cancellationLimitHours?: number | null;
  }): AppointmentNotice {
    const reason = params.reason?.trim() || undefined;
    if (reason && reason.length > NOTICE_REASON_MAX_LENGTH) {
      throw new Error(`O motivo tem no máximo ${NOTICE_REASON_MAX_LENGTH} caracteres.`);
    }
    const notice = new AppointmentNotice({
      id: params.id,
      tenantId: params.appointment.tenantId,
      appointmentId: params.appointment.id,
      patientId: params.appointment.patientId,
      channel: 'painel',
      recordedAt: params.now,
      referenceTime: params.now,
      referenceSource: 'registro_no_painel',
      classification: classifyNoticeTiming(params.now, params.appointment.scheduledAt, params.cancellationLimitHours),
      intent: params.intent,
      intentSource: 'pessoa',
      requestedBy: params.requestedBy,
      recordedByUserId: params.recordedByUserId,
      recordedByActorType: 'user',
      reason,
      // Registrada por quem age sobre a consulta, no mesmo ato: nada a rever.
      reviewStatus: 'sem_revisao_necessaria',
    });
    notice._pendingEvents.push(new NoticeRecordedEvent(notice));
    return notice;
  }

  static reconstitute(props: AppointmentNoticeProps): AppointmentNotice {
    return new AppointmentNotice(props);
  }

  /**
   * K11 (D2, D3, D7) — o pedido de cancelamento ou remarcação feito pelo
   * paciente no WhatsApp, antes do início. Não muda a consulta: fica
   * aguardando a confirmação em outra mensagem. Guarda o retrato da consulta
   * perguntada (horário e modalidade) para a confirmação conferir que ela
   * não mudou, e, na remarcação, o horário novo. A antecedência é a desta
   * primeira mensagem (decisão K11 da rodada 5).
   */
  static requestFromWhatsApp(params: {
    id: string;
    appointment: Appointment;
    intent: RequestIntent;
    proposedScheduledAt?: Date;
    message: WhatsAppMessageRef;
    now: Date;
    cancellationLimitHours?: number | null;
  }): AppointmentNotice {
    const requestedAction: NoticeRequestedAction = params.intent === 'pedido_remarcacao' ? 'remarcar' : 'cancelar';
    if ((requestedAction === 'remarcar') !== (params.proposedScheduledAt !== undefined)) {
      throw new Error('Só o pedido de remarcação leva um horário novo, e ele sempre leva.');
    }
    const classification = classifyNoticeTiming(params.message.receivedAt, params.appointment.scheduledAt, params.cancellationLimitHours);
    if (classification.timing === 'depois_do_inicio') {
      throw new Error('Um pedido de cancelamento ou remarcação só é aberto antes do início previsto.');
    }
    const notice = new AppointmentNotice({
      id: params.id,
      tenantId: params.appointment.tenantId,
      appointmentId: params.appointment.id,
      patientId: params.appointment.patientId,
      channel: 'whatsapp',
      recordedAt: params.now,
      referenceTime: params.message.receivedAt,
      referenceSource: 'recebimento_webhook',
      classification,
      intent: params.intent,
      intentSource: 'ia',
      requestedBy: 'paciente',
      recordedByActorType: 'ai_agent',
      reviewStatus: 'sem_revisao_necessaria',
      messageId: params.message.messageId,
      receivedAt: params.message.receivedAt,
      conversationId: params.message.conversationId,
      awaitsConfirmation: true,
      requestedAction,
      askedScheduledAt: params.appointment.scheduledAt,
      askedModality: params.appointment.modality,
      proposedScheduledAt: params.proposedScheduledAt,
    });
    notice._pendingEvents.push(new NoticeRecordedEvent(notice));
    return notice;
  }

  /**
   * K11 (D2, D4) — a resposta do paciente à pergunta de confirmação: outra
   * linha, ligada ao pedido, da mesma consulta e da mesma conversa. Registrar
   * a resposta não executa nada; quem executa (só com `confirma`) é o caso
   * de uso, que confere as demais condições. A classificação é a do momento
   * da resposta: uma confirmação no início ou depois dele não vale.
   * `needsReview` marca a resposta que a equipe tem de rever mesmo sendo
   * `confirma` (a consulta mudou depois da pergunta).
   */
  static replyFromWhatsApp(params: {
    id: string;
    request: AppointmentNotice;
    appointment: Appointment;
    answer: NoticeConfirmationAnswer;
    message: WhatsAppMessageRef;
    now: Date;
    cancellationLimitHours?: number | null;
    needsReview?: boolean;
  }): AppointmentNotice {
    const { request, appointment, message } = params;
    if (!request.awaitsConfirmation || request.appointmentId !== appointment.id || request.conversationId !== message.conversationId) {
      throw new Error('A resposta é sempre a um pedido da mesma consulta e da mesma conversa.');
    }
    if (request.messageId === message.messageId) {
      throw new Error('A confirmação vem em outra mensagem, nunca na do próprio pedido.');
    }
    const classification = classifyNoticeTiming(message.receivedAt, appointment.scheduledAt, params.cancellationLimitHours);
    const settledByItself = params.answer === 'confirma' && classification.timing !== 'depois_do_inicio' && !params.needsReview;
    const notice = new AppointmentNotice({
      id: params.id,
      tenantId: appointment.tenantId,
      appointmentId: appointment.id,
      patientId: appointment.patientId,
      channel: 'whatsapp',
      recordedAt: params.now,
      referenceTime: message.receivedAt,
      referenceSource: 'recebimento_webhook',
      classification,
      intent: request.intent,
      intentSource: 'ia',
      requestedBy: 'paciente',
      recordedByActorType: 'ai_agent',
      // Recusa, resposta ambígua ou confirmação tardia vão para a equipe.
      reviewStatus: settledByItself ? 'sem_revisao_necessaria' : 'pendente',
      messageId: message.messageId,
      receivedAt: message.receivedAt,
      conversationId: message.conversationId,
      awaitsConfirmation: false,
      confirmsNoticeId: request.id,
      confirmationAnswer: params.answer,
    });
    notice._pendingEvents.push(new NoticeRecordedEvent(notice));
    return notice;
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
  get channel(): NoticeChannel {
    return this.props.channel;
  }
  get recordedAt(): Date {
    return this.props.recordedAt;
  }
  get referenceTime(): Date {
    return this.props.referenceTime;
  }
  get referenceSource(): NoticeReferenceSource {
    return this.props.referenceSource;
  }
  get timing(): NoticeTiming {
    return this.props.classification.timing;
  }
  get minutesFromStart(): number {
    return this.props.classification.minutesFromStart;
  }
  get limitHoursApplied(): number | undefined {
    return this.props.classification.limitHoursApplied;
  }
  get intent(): NoticeIntent {
    return this.props.intent;
  }
  get intentSource(): 'ia' | 'pessoa' {
    return this.props.intentSource;
  }
  get requestedBy(): NoticeRequestedBy | undefined {
    return this.props.requestedBy;
  }
  get recordedByUserId(): string | undefined {
    return this.props.recordedByUserId;
  }
  get recordedByActorType(): 'user' | 'ai_agent' | 'system' {
    return this.props.recordedByActorType;
  }
  get reason(): string | undefined {
    return this.props.reason;
  }
  get reviewStatus(): NoticeReviewStatus {
    return this.props.reviewStatus;
  }

  get messageId(): string | undefined {
    return this.props.messageId;
  }
  get receivedAt(): Date | undefined {
    return this.props.receivedAt;
  }
  get conversationId(): string | undefined {
    return this.props.conversationId;
  }
  get awaitsConfirmation(): boolean {
    return this.props.awaitsConfirmation === true;
  }
  get requestedAction(): NoticeRequestedAction | undefined {
    return this.props.requestedAction;
  }
  get askedScheduledAt(): Date | undefined {
    return this.props.askedScheduledAt;
  }
  get askedModality(): string | undefined {
    return this.props.askedModality;
  }
  get proposedScheduledAt(): Date | undefined {
    return this.props.proposedScheduledAt;
  }
  get confirmsNoticeId(): string | undefined {
    return this.props.confirmsNoticeId;
  }
  get confirmationAnswer(): NoticeConfirmationAnswer | undefined {
    return this.props.confirmationAnswer;
  }

  /** Antes do início previsto (no prazo, fora do prazo ou sem limite). */
  get isBeforeStart(): boolean {
    return this.timing !== 'depois_do_inicio';
  }

  /**
   * K11 (D4) — a consulta ainda é a que foi perguntada: mesmo horário e mesma
   * modalidade. Uma consulta mudada no intervalo não é confirmada pela
   * resposta a uma pergunta sobre outra.
   */
  stillDescribes(appointment: Appointment): boolean {
    return (
      this.props.appointmentId === appointment.id &&
      this.props.askedScheduledAt?.getTime() === appointment.scheduledAt.getTime() &&
      this.props.askedModality === appointment.modality
    );
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }
}
