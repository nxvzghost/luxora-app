import { ConversationMessage, UsageMetrics } from './ai-provider';
import { ContactState } from '@domain/contact/contact.entity';

/**
 * ContactIntentClassifier — porta (ADR-0055/AD-018, Fase 6).
 *
 * Eixo de classificação SEPARADO de IAIProvider.interpretIntent() —
 * aquele decide "o que o paciente quer fazer" (agendar_consulta, etc.);
 * este decide "o que fazer com o vínculo de identidade do Contact".
 * Devolve só um rótulo estruturado — nenhuma regra de domínio, nenhuma
 * gravação, nenhum acesso a Aggregate: a decisão final de agir (ou não)
 * pertence sempre ao ContactIntentActionRouter (backend), nunca a este
 * classificador. `reasoning`, quando presente, é só para
 * observabilidade/auditoria — nunca controla fluxo.
 */
export type ContactIntentDecision = 'PROMOVER' | 'ASSOCIAR' | 'DESAMBIGUAR' | 'IGNORAR' | 'HUMANO';

export interface ContactIntentClassificationInput {
  tenantId: string;
  conversationHistory: ConversationMessage[];
  message: string;
  /** Estado atual do Contact — contexto simples (string), nunca o Aggregate. */
  contactState: ContactState;
  /** Quantas associações Contact↔Patient o Contact já possui — nunca a lista completa. */
  associationCount: number;
  /** ADR-0016 — correlaciona esta chamada com o restante dos logs do job/requisição de origem. */
  correlationId?: string;
}

export interface ContactIntentClassificationResult {
  decision: ContactIntentDecision;
  confidence: number;
  /** Nome mencionado na conversa (ex.: "meu filho João") — só um hint textual, nunca um patientId resolvido. */
  patientNameHint?: string;
  /** Só para observabilidade/auditoria — nunca usado para decidir o fluxo. */
  reasoning?: string;
  /** ADR-0055 (AD-018), Fase 7 — RNF-021: custo real desta chamada. */
  usage?: UsageMetrics;
}

export interface ContactIntentClassifier {
  classify(input: ContactIntentClassificationInput): Promise<ContactIntentClassificationResult>;
}

export const CONTACT_INTENT_CLASSIFIER = Symbol('CONTACT_INTENT_CLASSIFIER');
