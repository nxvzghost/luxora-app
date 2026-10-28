import { AppointmentNotice } from '@domain/appointment/appointment-notice';

/** K11 — um pedido feito pelo WhatsApp e as respostas a ele, da mais antiga para a mais nova. */
export interface AppointmentRequestThread {
  request: AppointmentNotice;
  replies: AppointmentNotice[];
}

/**
 * K2-b (ADR-0069, seção 3.2) — comunicações do paciente, somente acréscimo.
 * K11 — os pedidos pelo WhatsApp e as respostas a eles são lidos para
 * derivar o estado do pedido (appointment-request.ts); nada é reescrito. A
 * revisão (N2) continua das fases seguintes.
 */
export interface AppointmentNoticeRepository {
  insert(notice: AppointmentNotice): Promise<void>;
  /** K11 — a comunicação gerada por uma mensagem do WhatsApp (message_id único): a reentrega não duplica nada. */
  findByMessageId(messageId: string): Promise<AppointmentNotice | null>;
  /**
   * K11 — pedidos que aguardaram confirmação, com as respostas, registrados a
   * partir de `since`; só os de uma conversa, quando informada. Do mais antigo
   * para o mais novo.
   */
  findRequests(query: { since: Date; conversationId?: string }): Promise<AppointmentRequestThread[]>;
}

export const APPOINTMENT_NOTICE_REPOSITORY = Symbol('APPOINTMENT_NOTICE_REPOSITORY');
