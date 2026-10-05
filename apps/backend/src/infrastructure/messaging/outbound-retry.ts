import { MessageProviderError } from '@domain-services/communication/message-provider';

/**
 * Espera entre tentativas da fila de saída ('messages') — Fase 3B da auditoria.
 *
 * Sem indicação do provider, a espera é a mesma de sempre: 2 s e 4 s
 * (exponencial, base de 2 s), com 3 tentativas ao todo. Quando o provider
 * devolve `Retry-After` numa resposta repetível (429 ou 5xx), a espera
 * passa a respeitar esse valor — dentro de limites nossos:
 *
 *   - nunca menor que a espera padrão daquela tentativa (o provider não
 *     consegue fazer o worker insistir mais rápido);
 *   - nunca maior que MAX_PROVIDER_RETRY_AFTER_MS (o provider não consegue
 *     prender um job por tempo indefinido).
 *
 * O número de tentativas não muda: um 429 com `Retry-After` continua
 * contando como tentativa, então não há como repetir para sempre.
 *
 * A Meta não documenta `Retry-After` para os limites da Cloud API (erros
 * 130429, 131048, 131056) — orienta só a "tentar mais tarde". O suporte
 * aqui é defensivo: usa o cabeçalho se ele vier, não depende dele.
 */

/** Nome do tipo de espera gravado no job. Qualquer nome que não seja um tipo nativo do BullMQ faz o worker usar a estratégia abaixo. */
export const OUTBOUND_BACKOFF_TYPE = 'provider-aware';

export const OUTBOUND_BASE_BACKOFF_MS = 2000;

/** Teto para a espera pedida pelo provider. */
export const MAX_PROVIDER_RETRY_AFTER_MS = 60_000;

/**
 * Lê o cabeçalho `Retry-After` (segundos inteiros ou data HTTP) e devolve a
 * espera em milissegundos. Ausente ou ilegível: `undefined`. Data no
 * passado: 0. Não aplica teto — isso é feito em outboundRetryDelayMs().
 */
export function parseRetryAfterMs(headerValue: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  const value = headerValue?.trim();
  if (!value) {
    return undefined;
  }

  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }

  // Data HTTP ("Wed, 21 Oct 2026 07:28:00 GMT") — exige letras, para um
  // número malformado ("-5", "1.5") nunca ser lido como data.
  if (!/[a-z]/i.test(value)) {
    return undefined;
  }
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) {
    return undefined;
  }
  return Math.max(0, dateMs - nowMs);
}

/** Espera antes da próxima tentativa. `attemptsMade` começa em 1 (a tentativa que acabou de falhar). */
export function outboundRetryDelayMs(attemptsMade: number, err?: unknown, baseDelayMs: number = OUTBOUND_BASE_BACKOFF_MS): number {
  const standardDelay = baseDelayMs * 2 ** Math.max(0, attemptsMade - 1);
  const requested = err instanceof MessageProviderError ? err.retryAfterMs : undefined;

  if (requested === undefined || !Number.isFinite(requested)) {
    return standardDelay;
  }
  return Math.min(Math.max(requested, standardDelay), MAX_PROVIDER_RETRY_AFTER_MS);
}
