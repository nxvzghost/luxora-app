export interface SendMessageInput {
  tenantId: string;
  toPhoneNumber: string;
  body: string;
  /** Chave de idempotência do envio — nunca reenviar a mesma mensagem por retry de fila. */
  idempotencyKey: string;
  /** AD-016 — propagado até o header da chamada externa (ver WhatsAppMessageProvider). */
  correlationId?: string;
}

export interface SendMessageResult {
  providerMessageId: string;
  sentAt: Date;
}

/**
 * MessageProvider — porta. Implementação real (WhatsApp Business API) vive
 * em infrastructure/, nunca aqui — mesma regra de Dependency Inversion já
 * aplicada a todos os Repositories (ADR-0027, Módulo 06).
 */
export interface MessageProvider {
  send(input: SendMessageInput): Promise<SendMessageResult>;
}

export const MESSAGE_PROVIDER = Symbol('MESSAGE_PROVIDER');
