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
}

export interface IntentResult {
  intent: string;
  confidence: number;
  entities: Record<string, unknown>;
  requiresEscalation: boolean;
  escalationReason?: string;
}

export interface ConversationContext {
  tenantId: string;
  patientId?: string;
  therapistId?: string;
  conversationHistory: ConversationMessage[];
  intent: IntentResult;
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
