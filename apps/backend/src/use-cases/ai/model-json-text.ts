/**
 * unwrapModelJson — tira a cerca de código Markdown que envolve a resposta
 * inteira do modelo, antes do `JSON.parse`.
 *
 * Achado no primeiro teste contra a API real (19/10/2026,
 * test/manual/anthropic-smoke.test.ts): o claude-haiku-4-5-20251001 devolve
 * o JSON pedido, mas entre cercas (```json … ```), mesmo com o prompt pedindo
 * "APENAS um JSON válido, sem texto adicional". Aconteceu nas duas chamadas
 * que esperam JSON — interpretIntent() e o ContactIntentClassifier — e as
 * duas caíam no ramo de segurança (escalar / HUMANO) em toda mensagem. Os
 * dublês dos testes unitários sempre devolviam JSON puro; por isso o defeito
 * nunca tinha aparecido.
 *
 * Só remove UMA cerca que envolva a resposta inteira. Não procura JSON no
 * meio de um texto: resposta com texto antes ou depois da cerca continua
 * ilegível, e os parsers seguem caindo no ramo de segurança.
 */
const FENCED_RESPONSE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

export function unwrapModelJson(text: string): string {
  const trimmed = text.trim();
  const match = FENCED_RESPONSE.exec(trimmed);
  return match ? match[1] : trimmed;
}
