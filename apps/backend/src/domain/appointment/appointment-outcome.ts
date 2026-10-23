import { DomainEvent } from '../shared/domain-event';
import type { Appointment, AppointmentState } from './appointment.entity';
import { NOTICE_REASON_MAX_LENGTH, type AppointmentNotice, type NoticeRequestedBy, type NoticeTiming } from './appointment-notice';

/**
 * Desfecho da consulta — K2-b (ADR-0069, seções 2.4 a 2.6; DP-22 a DP-26).
 *
 * O desfecho não é um estado de agenda: fica num registro próprio, 1:1 com
 * a consulta, e AppointmentState não ganha valor novo (alternativa (b)). O
 * registro guarda um retrato do estado, do horário e da modalidade da
 * consulta no momento em que foi gravado; no banco esse retrato é a chave
 * estrangeira que congela a consulta.
 *
 * Quem registra realização e falta é sempre uma pessoa, depois do início
 * previsto. Confirmar, o tempo passar ou existir cobrança nunca é
 * realização (DP-26, DP-27). Nada aqui cria cobrança: a cobrança da falta
 * só existe depois da confirmação de um administrador (T8), e o item de
 * aviso fora do prazo fica para a decisão de consequência, fora desta fase.
 */
export type AppointmentOutcome = 'Realizada' | 'Falta' | 'FaltaAbonada' | 'AvisoTardio' | 'Remarcada' | 'Cancelada';
export type NoShowDecision = 'aguardando_decisao' | 'cobranca_confirmada';
export type LateNoticeDecision = 'aguardando_decisao' | 'sem_cobranca' | 'cobranca_confirmada';
export type AppointmentDecisionKind = 'cobranca_de_falta_confirmada' | 'falta_abonada' | 'abono_revertido';

export type AppointmentRuleCode =
  | 'APPOINTMENT_ALREADY_STARTED'
  | 'APPOINTMENT_NOT_STARTED'
  | 'APPOINTMENT_OUTCOME_CONFLICT'
  | 'APPOINTMENT_ALREADY_RESCHEDULED'
  | 'NO_SHOW_DECISION_CLOSED'
  | 'REASON_REQUIRED';

/** Regra do ciclo da consulta recusada. Os casos de uso a traduzem para a resposta da API. */
export class AppointmentRuleViolation extends Error {
  constructor(
    readonly code: AppointmentRuleCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppointmentRuleViolation';
  }
}

/** Resultado de uma decisão: aplicada agora, ou já estava assim (repetição sem efeito, sem evento novo). */
export type DecisionResult = 'applied' | 'unchanged';

/** Uma decisão sobre o desfecho, para o histórico somente de acréscimo (appointment_decision). */
export interface AppointmentDecisionRecord {
  id: string;
  tenantId: string;
  appointmentId: string;
  decision: AppointmentDecisionKind;
  reason?: string;
  decidedAt: Date;
  decidedByUserId: string;
}

export interface AppointmentOutcomeProps {
  appointmentId: string;
  tenantId: string;
  outcome: AppointmentOutcome;
  recordedAt: Date;
  recordedByUserId: string;
  stateAtOutcome: AppointmentState;
  scheduledAtAtOutcome: Date;
  modalityAtOutcome: string;
  closingNoticeId?: string;
  closingNoticeTiming?: NoticeTiming;
  noShowDecision?: NoShowDecision;
  noShowDecisionAt?: Date;
  noShowDecisionByUserId?: string;
  lateNoticeDecision?: LateNoticeDecision;
  lateNoticeDecisionAt?: Date;
  lateNoticeDecisionByUserId?: string;
}

abstract class OutcomeEvent extends DomainEvent {
  protected constructor(eventName: string, record: AppointmentOutcomeRecord, extra: Record<string, unknown> = {}) {
    super(eventName, record.appointmentId, record.tenantId, { outcome: record.outcome, ...extra });
  }
}

export class AttendanceRecordedEvent extends OutcomeEvent {
  constructor(record: AppointmentOutcomeRecord, sessionId: string | null) {
    super('RealizacaoRegistrada', record, { sessionId });
  }
}

export class NoShowRecordedEvent extends OutcomeEvent {
  constructor(record: AppointmentOutcomeRecord) {
    super('FaltaRegistrada', record, { noShowDecision: record.noShowDecision });
  }
}

export class AppointmentCancelledEvent extends OutcomeEvent {
  constructor(record: AppointmentOutcomeRecord, notice: AppointmentNotice) {
    super('ConsultaCancelada', record, noticeSummary(record, notice));
  }
}

export class AppointmentRescheduledEvent extends OutcomeEvent {
  constructor(record: AppointmentOutcomeRecord, notice: AppointmentNotice, newAppointmentId: string) {
    super('ConsultaRemarcada', record, { ...noticeSummary(record, notice), newAppointmentId });
  }
}

export class NoShowChargeConfirmedEvent extends OutcomeEvent {
  constructor(record: AppointmentOutcomeRecord, sessionId: string) {
    super('CobrancaDeFaltaConfirmada', record, { sessionId });
  }
}

// O motivo do abono e da reversão fica em appointment_decision, nunca na
// auditoria (seção 2.10): pode conter informação clínica.
export class NoShowExcusedEvent extends OutcomeEvent {
  constructor(record: AppointmentOutcomeRecord) {
    super('FaltaAbonada', record);
  }
}

export class NoShowExcuseRevertedEvent extends OutcomeEvent {
  constructor(record: AppointmentOutcomeRecord) {
    super('AbonoRevertido', record, { noShowDecision: record.noShowDecision });
  }
}

function noticeSummary(record: AppointmentOutcomeRecord, notice: AppointmentNotice): Record<string, unknown> {
  return {
    noticeId: notice.id,
    noticeTiming: notice.timing,
    limitHoursApplied: notice.limitHoursApplied ?? null,
    requestedBy: notice.requestedBy ?? null,
    lateNoticeDecision: record.lateNoticeDecision ?? null,
  };
}

/**
 * DP-22 e DP-25 — cancelamento ou remarcação pedidos pelo paciente fora do
 * prazo abrem a decisão de consequência; o padrão da clínica é a decisão
 * humana (a política por clínica é de outra fase). Pedido da clínica ou do
 * profissional nunca gera consequência para o paciente.
 */
function lateNoticeDecisionFor(timing: NoticeTiming, requestedBy: NoticeRequestedBy | undefined): LateNoticeDecision | undefined {
  return timing === 'fora_do_prazo' && requestedBy === 'paciente' ? 'aguardando_decisao' : undefined;
}

function requireReason(reason: string | undefined): string {
  const trimmed = reason?.trim();
  if (!trimmed) {
    throw new AppointmentRuleViolation('REASON_REQUIRED', 'Informe o motivo.');
  }
  if (trimmed.length > NOTICE_REASON_MAX_LENGTH) {
    throw new Error(`O motivo tem no máximo ${NOTICE_REASON_MAX_LENGTH} caracteres.`);
  }
  return trimmed;
}

export class AppointmentOutcomeRecord {
  private _pendingEvents: DomainEvent[] = [];

  private constructor(private readonly props: AppointmentOutcomeProps) {}

  static reconstitute(props: AppointmentOutcomeProps): AppointmentOutcomeRecord {
    return new AppointmentOutcomeRecord(props);
  }

  /** Retrato da consulta como ela está agora: é o que o banco passa a exigir que não mude. */
  private static snapshot(appointment: Appointment) {
    return {
      appointmentId: appointment.id,
      tenantId: appointment.tenantId,
      stateAtOutcome: appointment.state,
      scheduledAtAtOutcome: appointment.scheduledAt,
      modalityAtOutcome: appointment.modality,
    };
  }

  /** Realização (T6) e falta (T7): pessoa, consulta aberta, depois do início previsto. */
  private static assertAttendanceOutcomeAllowed(appointment: Appointment, now: Date): void {
    if (!appointment.isOpen) {
      throw new AppointmentRuleViolation(
        'APPOINTMENT_OUTCOME_CONFLICT',
        `Uma consulta no estado "${appointment.state}" não recebe realização nem falta.`,
      );
    }
    if (!appointment.hasStarted(now)) {
      throw new AppointmentRuleViolation('APPOINTMENT_NOT_STARTED', 'A consulta ainda não começou.');
    }
  }

  static recordAttendance(appointment: Appointment, by: { userId: string; now: Date }): AppointmentOutcomeRecord {
    AppointmentOutcomeRecord.assertAttendanceOutcomeAllowed(appointment, by.now);
    return new AppointmentOutcomeRecord({
      ...AppointmentOutcomeRecord.snapshot(appointment),
      outcome: 'Realizada',
      recordedAt: by.now,
      recordedByUserId: by.userId,
    });
  }

  static recordNoShow(appointment: Appointment, by: { userId: string; now: Date }): AppointmentOutcomeRecord {
    AppointmentOutcomeRecord.assertAttendanceOutcomeAllowed(appointment, by.now);
    const record = new AppointmentOutcomeRecord({
      ...AppointmentOutcomeRecord.snapshot(appointment),
      outcome: 'Falta',
      recordedAt: by.now,
      recordedByUserId: by.userId,
      noShowDecision: 'aguardando_decisao',
    });
    record._pendingEvents.push(new NoShowRecordedEvent(record));
    return record;
  }

  /**
   * Cancelamento (T3) e remarcação (T5) pelo painel: a consulta já foi
   * levada a `Cancelada` (para a versão anterior, uma consulta cancelada; e
   * o horário fica livre) e a comunicação que a encerra foi registrada
   * antes do início. A ordem é a do banco: o retrato só aceita a consulta
   * já cancelada.
   */
  static closeByNotice(
    appointment: Appointment,
    notice: AppointmentNotice,
    outcome: 'Cancelada' | 'Remarcada',
    by: { userId: string; now: Date; newAppointmentId?: string },
  ): AppointmentOutcomeRecord {
    if (appointment.state !== 'Cancelada') {
      throw new Error('O desfecho de cancelamento ou remarcação só é gravado depois de a consulta ficar Cancelada.');
    }
    if (notice.appointmentId !== appointment.id || !notice.isBeforeStart) {
      throw new AppointmentRuleViolation('APPOINTMENT_ALREADY_STARTED', 'A consulta já começou: não pode mais ser cancelada nem remarcada.');
    }
    const record = new AppointmentOutcomeRecord({
      ...AppointmentOutcomeRecord.snapshot(appointment),
      outcome,
      recordedAt: by.now,
      recordedByUserId: by.userId,
      closingNoticeId: notice.id,
      closingNoticeTiming: notice.timing,
      lateNoticeDecision: lateNoticeDecisionFor(notice.timing, notice.requestedBy),
    });
    record._pendingEvents.push(
      outcome === 'Cancelada'
        ? new AppointmentCancelledEvent(record, notice)
        : new AppointmentRescheduledEvent(record, notice, by.newAppointmentId ?? ''),
    );
    return record;
  }

  /** Só depois de criado o item faturável, que dá o id da sessão ao evento. */
  markAttendanceRecorded(sessionId: string | null): void {
    this._pendingEvents.push(new AttendanceRecordedEvent(this, sessionId));
  }

  /**
   * T8, antes de qualquer gravação: a falta ainda espera decisão
   * (`pending`) ou a cobrança já foi confirmada (`confirmed`, repetição).
   * Recusa abono e qualquer outro desfecho.
   */
  noShowChargeStatus(): 'pending' | 'confirmed' {
    this.assertNoShowAwaiting({ allowCharged: true });
    return this.props.noShowDecision === 'cobranca_confirmada' ? 'confirmed' : 'pending';
  }

  /** T8 — o administrador confirma a cobrança da falta. Só a partir de `Falta` aguardando decisão. */
  confirmNoShowCharge(by: { userId: string; now: Date; sessionId: string }): DecisionResult {
    if (this.noShowChargeStatus() === 'confirmed') return 'unchanged';
    this.props.noShowDecision = 'cobranca_confirmada';
    this.props.noShowDecisionAt = by.now;
    this.props.noShowDecisionByUserId = by.userId;
    this._pendingEvents.push(new NoShowChargeConfirmedEvent(this, by.sessionId));
    return 'applied';
  }

  /** T9 — abono, com motivo obrigatório (DP-23). Quem pode abonar é conferido no caso de uso. */
  excuseNoShow(by: { userId: string; now: Date; reason?: string }): DecisionResult {
    requireReason(by.reason);
    if (this.props.outcome === 'FaltaAbonada') return 'unchanged';
    this.assertNoShowAwaiting({ allowCharged: false });
    this.props.outcome = 'FaltaAbonada';
    this.props.noShowDecision = undefined;
    this.props.noShowDecisionAt = undefined;
    this.props.noShowDecisionByUserId = undefined;
    this._pendingEvents.push(new NoShowExcusedEvent(this));
    return 'applied';
  }

  /** T9b — reversão do abono pelo administrador, com motivo (DP-24a): volta à decisão humana, sem cobrança. */
  revertExcuse(by: { userId: string; now: Date; reason?: string }): DecisionResult {
    requireReason(by.reason);
    if (this.props.outcome === 'Falta' && this.props.noShowDecision === 'aguardando_decisao') return 'unchanged';
    if (this.props.outcome !== 'FaltaAbonada') {
      throw new AppointmentRuleViolation('APPOINTMENT_OUTCOME_CONFLICT', 'Só um abono pode ser revertido.');
    }
    this.props.outcome = 'Falta';
    this.props.noShowDecision = 'aguardando_decisao';
    this._pendingEvents.push(new NoShowExcuseRevertedEvent(this));
    return 'applied';
  }

  private assertNoShowAwaiting(options: { allowCharged: boolean }): void {
    if (this.props.outcome === 'FaltaAbonada') {
      throw new AppointmentRuleViolation('NO_SHOW_DECISION_CLOSED', 'A falta foi abonada: a decisão está encerrada.');
    }
    if (this.props.outcome !== 'Falta') {
      throw new AppointmentRuleViolation('APPOINTMENT_OUTCOME_CONFLICT', `O desfecho desta consulta é "${this.props.outcome}", não falta.`);
    }
    if (!options.allowCharged && this.props.noShowDecision === 'cobranca_confirmada') {
      throw new AppointmentRuleViolation('NO_SHOW_DECISION_CLOSED', 'A cobrança desta falta já foi confirmada.');
    }
  }

  get appointmentId(): string {
    return this.props.appointmentId;
  }
  get tenantId(): string {
    return this.props.tenantId;
  }
  get outcome(): AppointmentOutcome {
    return this.props.outcome;
  }
  get recordedAt(): Date {
    return this.props.recordedAt;
  }
  get recordedByUserId(): string {
    return this.props.recordedByUserId;
  }
  get stateAtOutcome(): AppointmentState {
    return this.props.stateAtOutcome;
  }
  get scheduledAtAtOutcome(): Date {
    return this.props.scheduledAtAtOutcome;
  }
  get modalityAtOutcome(): string {
    return this.props.modalityAtOutcome;
  }
  get closingNoticeId(): string | undefined {
    return this.props.closingNoticeId;
  }
  get closingNoticeTiming(): NoticeTiming | undefined {
    return this.props.closingNoticeTiming;
  }
  get noShowDecision(): NoShowDecision | undefined {
    return this.props.noShowDecision;
  }
  get noShowDecisionAt(): Date | undefined {
    return this.props.noShowDecisionAt;
  }
  get noShowDecisionByUserId(): string | undefined {
    return this.props.noShowDecisionByUserId;
  }
  get lateNoticeDecision(): LateNoticeDecision | undefined {
    return this.props.lateNoticeDecision;
  }
  get lateNoticeDecisionAt(): Date | undefined {
    return this.props.lateNoticeDecisionAt;
  }
  get lateNoticeDecisionByUserId(): string | undefined {
    return this.props.lateNoticeDecisionByUserId;
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }
}
