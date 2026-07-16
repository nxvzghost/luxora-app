export interface MessageLogRepository {
  findByIdempotencyKey(key: string): Promise<{ id: string; providerMessageId: string | null } | null>;
  record(entry: {
    tenantId: string;
    toPhoneNumber: string;
    body: string;
    idempotencyKey: string;
    providerMessageId: string;
  }): Promise<void>;
}

export const MESSAGE_LOG_REPOSITORY = Symbol('MESSAGE_LOG_REPOSITORY');
