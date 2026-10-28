/**
 * IAIProvider — porta. Fonte: 02 - CTO/clinicos/docs/05-IA/00-Provedor-e-Interface.md.
 * Nenhum Caso de Uso do Backend chama o SDK da Anthropic diretamente —
 * sempre através desta interface.
 */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * K11 (D3) — uma consulta futura do paciente como a IA a vê: o suficiente para
 * reconhecer de qual ele fala (data, dia da semana, horário, profissional,
 * modalidade), no fuso da clínica. Nenhum identificador interno (A-14): quem
 * localiza a consulta é o backend, a partir do que a IA extrair.
 */
export interface AppointmentForAi {
  date: string; // AAAA-MM-DD
  weekday: string;
  time: string; // HH:MM
  professional: string;
  modality: string;
}

/** K11 — o que a IA precisa saber das consultas e do pedido pendente para interpretar a mensagem. */
export interface AppointmentContextForAi {
  /** Hoje, no fuso da clínica: AAAA-MM-DD e dia da semana ("amanhã", "sexta"). */
  today: string;
  upcoming: AppointmentForAi[];
  /** A pergunta de confirmação que o paciente ainda não respondeu, como foi enviada a ele. */
  pendingQuestion?: string;
}

export interface ConversationInput {
  tenantId: string;
  patientId?: string;
  conversationHistory: ConversationMessage[];
  message: string;
  /** ADR-0055 (AD-018), Fase 8.2 — correlaciona esta chamada com o restante dos logs do job/requisição de origem. Aditivo, opcional. */
  correlationId?: string;
  /** K11 — só em interpretIntent, e só para o paciente identificado. */
  appointmentContext?: AppointmentContextForAi;
}

/**
 * K11 (D4) — como a IA classificou a mensagem diante da pergunta pendente:
 * confirma, recusa, resposta ambígua (inclusive "sim, mas…") ou mensagem que
 * não responde à pergunta. A classificação não executa nada sozinha: o
 * backend confere as demais condições antes de qualquer ação.
 */
export type ConfirmationClassification = 'confirma' | 'recusa' | 'ambigua' | 'nao_relacionada';

export interface IntentResult {
  intent: string;
  confidence: number;
  entities: Record<string, unknown>;
  requiresEscalation: boolean;
  escalationReason?: string;
  /** K11 — só quando havia pergunta pendente. */
  confirmation?: ConfirmationClassification;
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
