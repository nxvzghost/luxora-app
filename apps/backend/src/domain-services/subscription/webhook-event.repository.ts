export interface WebhookEventRepository {
  wasProcessed(asaasEventId: string): Promise<boolean>;
  markProcessed(asaasEventId: string, eventType: string): Promise<void>;
}

export const WEBHOOK_EVENT_REPOSITORY = Symbol('WEBHOOK_EVENT_REPOSITORY');
