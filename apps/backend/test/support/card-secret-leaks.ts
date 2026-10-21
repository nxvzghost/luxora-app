/**
 * Procura o código de segurança do cartão (CCV) num texto capturado de
 * resposta, log ou trace — R5 da auditoria.
 *
 * Procurar o CCV como pedaço de texto dá falso positivo: ele tem 3 ou 4
 * dígitos e aparece por acaso dentro de identificadores hexadecimais de span
 * e de trace (`d18ef9173494a762`), de timestamps em microssegundos
 * (`1792590191730000`), de portas efêmeras (`:49173`) e de segmentos de UUID
 * (`-9173-`). Foi o que derrubou o CI 39610045522: o exportador de console do
 * OpenTelemetry imprimiu um span com id `d18ef9173494a762` durante o teste.
 *
 * Por isso o CCV conta só quando aparece como valor:
 *   1. isolado entre delimitadores de serialização — início ou fim do texto,
 *      espaço, aspas, `:`, `=`, `,`, `&`, `[ ] { } ( )`. Pega
 *      `"ccv":"9173"`, `ccv: '9173'`, `ccv=9173` e `CCV 9173`; não pega
 *      dígitos ou letras hexadecimais vizinhos, nem `-`, `.` ou `/`;
 *   2. ou como valor de uma chave de código de segurança (`ccv`, `cvv`, `cvc`,
 *      `securityCode`), qualquer que seja o valor, desde que não seja a
 *      máscara `[omitido]` que `redactCardData` aplica. Pega um CCV vazado
 *      mesmo que não seja o do teste.
 *
 * Os formatos cobertos são os que o teste de fato produz: JSON (resposta da
 * API e corpo ecoado pela Asaas, inclusive com aspas escapadas dentro de uma
 * string), `util.inspect` (spans do exportador de console e objetos passados
 * ao logger) e texto livre de mensagem de log.
 */

const DELIMITER = String.raw`\s"'\x60:=,&\[\]{}()\\`;
// O valor capturado para no `]`, então a máscara chega como "[omitido".
const MASK_PREFIX = '[omitido';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Ocorrências do valor como token isolado (regra 1), com um trecho de contexto. */
function isolatedValueLeaks(text: string, value: string): string[] {
  const pattern = new RegExp(`(?:^|[${DELIMITER}])${escapeRegExp(value)}(?=$|[${DELIMITER}])`, 'g');
  return [...text.matchAll(pattern)].map((match) => context(text, match.index ?? 0, match[0].length));
}

/** Chaves de código de segurança com valor não mascarado (regra 2). */
function unmaskedKeyLeaks(text: string): string[] {
  const pattern = /\\?["'\x60]?\b(?:ccv|cvv|cvc|securityCode)\b\\?["'\x60]?\s*[:=]\s*\\?["'\x60]?([^"'\x60\\,}\]\s]*)/gi;
  return [...text.matchAll(pattern)]
    .filter((match) => match[1] !== '' && !match[1].startsWith(MASK_PREFIX))
    .map((match) => context(text, match.index ?? 0, match[0].length));
}

function context(text: string, start: number, length: number): string {
  return text.slice(Math.max(0, start - 20), start + length + 20);
}

/**
 * Trechos do texto em que o CCV aparece como valor, ou em que uma chave de
 * código de segurança tem valor não mascarado. Lista vazia = nada vazou.
 */
export function findCcvLeaks(text: string, ccv: string): string[] {
  return [...isolatedValueLeaks(text, ccv), ...unmaskedKeyLeaks(text)];
}
