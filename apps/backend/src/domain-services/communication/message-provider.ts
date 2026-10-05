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

/**
 * Falha de envio já classificada pelo provider (Fase 3 da auditoria).
 *
 * `retryable` decide o que a fila faz com o job: `true` (rede, timeout,
 * 429, 5xx) volta para nova tentativa; `false` (clínica sem canal
 * conectado, credencial recusada, requisição inválida) encerra o job na
 * hora — repetir a mesma chamada falharia do mesmo jeito.
 *
 * A mensagem nunca carrega token, corpo da mensagem nem o texto livre
 * devolvido pelo provider — só códigos e o id de rastreio dele.
 */
export class MessageProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MessageProviderError';
  }
}
