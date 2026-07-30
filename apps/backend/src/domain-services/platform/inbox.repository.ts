/**
 * InboxRepository — ADR-0054 (AD-036). Porta de infraestrutura, não de
 * domínio: garante que um consumidor de fila (hoje só WhatsAppInboundQueueWorker)
 * execute trabalho caro e não-idempotente (IA + IntentActionRouter +
 * persistência) no máximo uma vez por evento de entrada, mesmo sob retry
 * do BullMQ. `channel` é genérico ('whatsapp' hoje) para reuso por canais
 * futuros sem porta nova.
 *
 * Nunca expõe Conversation/Message — resultPayload é um cache técnico e
 * descartável, só o necessário para retomar o despacho (Fase 2) sem
 * reprocessar a IA (Fase 1).
 */
export interface InboxResultPayload {
  responseMessage: string;
  toPhoneNumber: string;
}

export type InboxClaimOutcome =
  | { outcome: 'claimed' }
  | { outcome: 'resume_dispatch'; resultPayload: InboxResultPayload }
  | { outcome: 'in_progress' };

export interface InboxClaimParams {
  channel: string;
  externalId: string;
  tenantId: string;
  conversationId: string;
  correlationId?: string;
}

export interface InboxRepository {
  /**
   * Reivindica o direito de processar este evento. Um segundo `tryClaim`
   * para o mesmo (channel, externalId) nunca resulta em 'claimed' de novo
   * enquanto o primeiro claim não expirar (staleness) ou falhar
   * explicitamente — ver ADR-0054 §Arquitetura para a máquina de estados
   * completa.
   */
  tryClaim(params: InboxClaimParams): Promise<InboxClaimOutcome>;
  /**
   * Fase 1 concluída com sucesso (IA + IntentActionRouter + persistência +
   * auditoria já ocorreram). A partir desta chamada, nenhum retry deve
   * jamais reexecutar a Fase 1 para este evento.
   */
  markGenerated(channel: string, externalId: string, resultPayload: InboxResultPayload): Promise<void>;
  /** Fase 2 (despacho) concluída com sucesso — estado terminal. */
  markDispatched(channel: string, externalId: string): Promise<void>;
  /**
   * Só deve ser chamado quando a Fase 1 falhar — nunca depois de
   * `markGenerated()` ter sido gravado com sucesso (ver ADR-0054 §Ponto 2).
   */
  markFailed(channel: string, externalId: string, error: string): Promise<void>;
}

export const INBOX_REPOSITORY = Symbol('INBOX_REPOSITORY');
