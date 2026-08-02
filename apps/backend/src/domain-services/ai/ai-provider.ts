/**
 * IAIProvider — porta. Fonte: 02 - CTO/clinicos/docs/05-IA/00-Provedor-e-Interface.md.
 * Nenhum Caso de Uso do Backend chama o SDK da Anthropic diretamente —
 * sempre através desta interface.
 */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConversationInput {
  tenantId: string;
  patientId?: string;
  conversationHistory: ConversationMessage[];
  message: string;
  /** ADR-0055 (AD-018), Fase 8.2 — correlaciona esta chamada com o restante dos logs do job/requisição de origem. Aditivo, opcional. */
  correlationId?: string;
}

export interface IntentResult {
  intent: string;
  confidence: number;
  entities: Record<string, unknown>;
  requiresEscalation: boolean;
  escalationReason?: string;
  /**
   * ADR-0055 (AD-018), Fase 7 — RNF-021: custo real desta chamada, para
   * ser somado ao custo de generateResponse() (e, quando aplicável, do
   * ContactIntentClassifier) antes de checar o teto de R$0,25/conversa.
   * Opcional para nunca quebrar um IAIProvider que ainda não o preencha.
   */
  usage?: UsageMetrics;
}

export interface ConversationContext {
  tenantId: string;
  patientId?: string;
  therapistId?: string;
  conversationHistory: ConversationMessage[];
  intent: IntentResult;
  /** ADR-0055 (AD-018), Fase 8.2 — correlaciona esta chamada com o restante dos logs do job/requisição de origem. Aditivo, opcional. */
  correlationId?: string;
}

export interface UsageMetrics {
  inputTokens: number;
  outputTokens: number;
  costEstimate: number;
  latencyMs: number;
}

export interface AIResponse {
  message: string;
  usage: UsageMetrics;
}

export interface IAIProvider {
  interpretIntent(input: ConversationInput): Promise<IntentResult>;
  generateResponse(context: ConversationContext): Promise<AIResponse>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');
