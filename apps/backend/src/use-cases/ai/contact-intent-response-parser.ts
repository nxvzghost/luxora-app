import {
  ContactIntentClassificationResult,
  ContactIntentDecision,
} from '@domain-services/ai/contact-intent-classifier';
import { unwrapModelJson } from './model-json-text';

const VALID_DECISIONS: readonly ContactIntentDecision[] = ['PROMOVER', 'ASSOCIAR', 'DESAMBIGUAR', 'IGNORAR', 'HUMANO'];

/**
 * parseContactIntentResponse — ADR-0055 (AD-018), Fase 7. Extraído de
 * AnthropicContactIntentClassifier (melhoria opcional sugerida na
 * aprovação da Fase 6). Nunca decide sozinho quando a resposta do modelo
 * não é um JSON válido ou traz um `decision` fora do vocabulário
 * esperado — HUMANO é o rótulo mais seguro (mesmo espírito de
 * AnthropicAIProvider.interpretIntent(), que escala por segurança em vez
 * de assumir um intent errado).
 *
 * ADR-0063 (AD-037) — `explicitConfirmation` só vale quando o modelo
 * devolve literalmente `true`. Qualquer outra coisa ("true" como texto, 1,
 * "sim", ausente) é falta de confirmação: na dúvida, nenhum cadastro.
 *
 * 19/10/2026 — o modelo real devolve o JSON entre cercas de código; a cerca
 * que envolve a resposta inteira é retirada antes da leitura (unwrapModelJson).
 */
export function parseContactIntentResponse(text: string): ContactIntentClassificationResult {
  try {
    const parsed = JSON.parse(unwrapModelJson(text)) as ContactIntentClassificationResult;
    if (!VALID_DECISIONS.includes(parsed.decision)) {
      throw new Error(`decision fora do vocabulário esperado: "${parsed.decision}"`);
    }
    return {
      decision: parsed.decision,
      confidence: parsed.confidence,
      patientNameHint: typeof parsed.patientNameHint === 'string' ? parsed.patientNameHint : undefined,
      explicitConfirmation: parsed.explicitConfirmation === true,
      reasoning: parsed.reasoning,
    };
  } catch {
    return { decision: 'HUMANO', confidence: 0, reasoning: 'Falha ao interpretar resposta do modelo.' };
  }
}
