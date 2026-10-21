import { Conversation, Message } from '@domain/communication/conversation.entity';

/** Parâmetros de ConversationRepository.findRecentMessagesBefore() — D-A do A-14. */
export interface RecentMessagesQuery {
  conversationId: string;
  /** WAMID da mensagem que está sendo processada: ela fica de fora, e nada depois dela entra. */
  currentExternalId: string;
  /** Mensagens criadas antes deste instante ficam de fora. */
  since: Date;
  /** Máximo de mensagens devolvidas — as mais recentes. */
  limit: number;
}

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
  /**
   * D-A do A-14 — o histórico que vai para a IA: as `limit` mensagens mais
   * recentes da conversa criadas a partir de `since` e anteriores à mensagem
   * `currentExternalId`, em ordem cronológica. A consulta já vem limitada do
   * banco; nada gravado é alterado.
   */
  findRecentMessagesBefore(query: RecentMessagesQuery): Promise<Message[]>;
}

export const CONVERSATION_REPOSITORY = Symbol('CONVERSATION_REPOSITORY');
