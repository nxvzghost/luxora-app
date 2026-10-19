export interface MessageLogRepository {
  findByIdempotencyKey(key: string): Promise<{ id: string; providerMessageId: string | null } | null>;
  record(entry: {
    tenantId: string;
    toPhoneNumber: string;
    body: string;
    idempotencyKey: string;
    providerMessageId: string;
  }): Promise<void>;
  /** A-08 — o envio que a Meta identifica por este id, para tratar um status de falha de entrega. */
  findByProviderMessageId(
    providerMessageId: string,
  ): Promise<{ id: string; idempotencyKey: string; toPhoneNumber: string; status: string } | null>;
  /** A-08 — a Meta avisou que a mensagem não chegou. Não lança se a linha não existir (ou for de outra clínica). */
  markFailed(id: string): Promise<void>;
}

export const MESSAGE_LOG_REPOSITORY = Symbol('MESSAGE_LOG_REPOSITORY');
