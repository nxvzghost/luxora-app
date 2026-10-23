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
 * Nesta fase só o painel grava comunicações, como parte do cancelamento e da
 * remarcação. O registro de cada mensagem do WhatsApp, com o carimbo da Meta
 * e a confirmação explícita do paciente (K11), é da fase 5.
 */
export type NoticeTiming = 'no_prazo' | 'fora_do_prazo' | 'sem_limite_configurado' | 'depois_do_inicio';
export type NoticeIntent = 'nao_comparecera' | 'atraso' | 'pedido_cancelamento' | 'pedido_remarcacao' | 'indefinida';
export type NoticeRequestedBy = 'paciente' | 'clinica' | 'profissional';
export type NoticeChannel = 'whatsapp' | 'painel';
export type NoticeReferenceSource = 'meta_timestamp' | 'recebimento_webhook' | 'registro_no_painel';
export type NoticeReviewStatus = 'pendente' | 'revisada' | 'sem_revisao_necessaria';

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
}

export class NoticeRecordedEvent extends DomainEvent {
  declare readonly appointmentId: string;
  declare readonly channel: NoticeChannel;
  declare readonly intent: NoticeIntent;
  declare readonly timing: NoticeTiming;
  declare readonly requestedBy: NoticeRequestedBy | null;

  constructor(notice: AppointmentNotice) {
    // O motivo livre não entra na auditoria (seção 2.10).
    super('ComunicacaoRegistrada', notice.id, notice.tenantId, {
      appointmentId: notice.appointmentId,
      channel: notice.channel,
      intent: notice.intent,
      timing: notice.timing,
      requestedBy: notice.requestedBy ?? null,
    });
  }
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

  /** Antes do início previsto (no prazo, fora do prazo ou sem limite). */
  get isBeforeStart(): boolean {
    return this.timing !== 'depois_do_inicio';
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }
}
