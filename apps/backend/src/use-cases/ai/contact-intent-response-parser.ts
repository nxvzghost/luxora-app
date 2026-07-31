import {
  ContactIntentClassificationResult,
  ContactIntentDecision,
} from '@domain-services/ai/contact-intent-classifier';

const VALID_DECISIONS: readonly ContactIntentDecision[] = ['PROMOVER', 'ASSOCIAR', 'DESAMBIGUAR', 'IGNORAR', 'HUMANO'];

/**
 * parseContactIntentResponse — ADR-0055 (AD-018), Fase 7. Extraído de
 * AnthropicContactIntentClassifier (melhoria opcional sugerida na
 * aprovação da Fase 6). Nunca decide sozinho quando a resposta do modelo
 * não é um JSON válido ou traz um `decision` fora do vocabulário
 * esperado — HUMANO é o rótulo mais seguro (mesmo espírito de
 * AnthropicAIProvider.interpretIntent(), que escala por segurança em vez
 * de assumir um intent errado).
 */
export function parseContactIntentResponse(text: string): ContactIntentClassificationResult {
  try {
    const parsed = JSON.parse(text) as ContactIntentClassificationResult;
    if (!VALID_DECISIONS.includes(parsed.decision)) {
      throw new Error(`decision fora do vocabulário esperado: "${parsed.decision}"`);
    }
    return {
      decision: parsed.decision,
      confidence: parsed.confidence,
      patientNameHint: parsed.patientNameHint,
      reasoning: parsed.reasoning,
    };
  } catch {
    return { decision: 'HUMANO', confidence: 0, reasoning: 'Falha ao interpretar resposta do modelo.' };
  }
}
