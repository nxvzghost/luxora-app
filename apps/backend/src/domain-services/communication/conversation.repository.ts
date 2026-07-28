import { Conversation, Message } from '@domain/communication/conversation.entity';

/**
 * ConversationRepository — ADR-0053. `save()`/`appendMessages()` split,
 * mesmo padrão já usado por BillingRepository.save()/linkSessions() —
 * nunca um único save() cascateando entidade filha.
 */
export interface ConversationRepository {
  findByTenantAndPhone(tenantId: string, phoneNumber: string): Promise<Conversation | null>;
  findById(id: string): Promise<Conversation | null>;
  /** Persiste só o cabeçalho da Conversation (nunca as Messages). */
  save(conversation: Conversation): Promise<void>;
  /** Persiste as Messages pendentes de uma Conversation (ver Conversation.pullPendingMessages()). */
  appendMessages(messages: Message[], tenantId: string): Promise<void>;
  /** Idempotência de entrada (ADR-0053 §5) — WAMID já processado? */
  findMessageByExternalId(externalId: string): Promise<Message | null>;
  /** Histórico ordenado (createdAt asc) — base de conversationHistory para ProcessarMensagemUseCase. */
  findMessagesByConversationId(conversationId: string): Promise<Message[]>;
}

export const CONVERSATION_REPOSITORY = Symbol('CONVERSATION_REPOSITORY');
