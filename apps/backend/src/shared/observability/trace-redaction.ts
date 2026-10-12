/**
 * O que não pode sair em um trace — Tarefa 07 da auditoria (Fase 1).
 *
 * Funções puras, sem import nenhum, pelo mesmo motivo de telemetry-env.ts:
 * são usadas na montagem das instrumentações, antes de qualquer outro módulo
 * ser carregado.
 *
 * Dois vazamentos medidos com as instrumentações em uso:
 *   1. a de HTTP grava a query string inteira da requisição (`url.query`; nas
 *      chamadas de saída, `url.full`). A verificação do webhook da Meta manda
 *      o token de verificação exatamente ali (`hub.verify_token`), como o
 *      protocolo exige;
 *   2. a do Redis grava os argumentos dos comandos. O BullMQ enfileira por
 *      script (`evalsha`), e os argumentos do script são o job inteiro — o
 *      telefone do paciente e o texto da mensagem.
 *
 * A regra é negar por padrão. De uma query string ficam os nomes dos
 * parâmetros e, só para os de SAFE_QUERY_PARAMS, o valor. De um comando
 * Redis ficam o nome e a quantidade de argumentos. Um parâmetro ou comando
 * novo nasce redigido, sem ninguém precisar lembrar dele.
 *
 * O que continua nos spans é o que se usa para operar: método, rota,
 * caminho, status, duração, nomes dos parâmetros, nome do comando.
 */
export const REDACTED = 'REDACTED';

/**
 * Parâmetros cujo valor não identifica ninguém nem autentica nada: paginação,
 * intervalo de datas, filtro de estado e o modo do handshake da Meta. Todo o
 * resto — `hub.verify_token`, `hub.challenge`, `cursor`, ids de paciente e de
 * terapeuta, e qualquer parâmetro que venha a existir — sai sem o valor.
 */
const SAFE_QUERY_PARAMS: ReadonlySet<string> = new Set(['limit', 'from', 'to', 'state', 'hub.mode']);

/** Acima disto um nome ou um valor "seguro" deixa de ser o que se espera dele. */
const MAX_KEPT_LENGTH = 64;

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Query string (sem o `?`) com os valores redigidos. */
export function redactQueryString(query: string): string {
  if (!query) return query;
  return query
    .split('&')
    .map((pair) => {
      if (pair === '') return pair;
      const separator = pair.indexOf('=');
      // Sem "=" não há como separar nome de valor: sai tudo.
      if (separator === -1) return REDACTED;
      const name = pair.slice(0, separator);
      if (name.length > MAX_KEPT_LENGTH) return REDACTED;
      const value = pair.slice(separator + 1);
      const safe = SAFE_QUERY_PARAMS.has(decoded(name)) && value.length <= MAX_KEPT_LENGTH;
      return safe ? pair : `${name}=${REDACTED}`;
    })
    .join('&');
}

/** Endereço (absoluto ou só caminho) com a query redigida e sem o conteúdo do fragmento. */
export function redactUrl(url: string): string {
  const fragmentStart = url.indexOf('#');
  const withoutFragment = fragmentStart === -1 ? url : url.slice(0, fragmentStart);
  const fragment = fragmentStart === -1 ? '' : `#${REDACTED}`;
  const queryStart = withoutFragment.indexOf('?');
  if (queryStart === -1) return `${withoutFragment}${fragment}`;
  return `${withoutFragment.slice(0, queryStart)}?${redactQueryString(withoutFragment.slice(queryStart + 1))}${fragment}`;
}

/** Atributos que levam a query string, nas convenções semânticas atuais e nas antigas. */
const QUERY_ATTRIBUTES = ['url.query'] as const;
const URL_ATTRIBUTES = ['url.full', 'http.url', 'http.target'] as const;

/** O que se usa de um span aqui. `attributes` existe no span do SDK, não na interface da API. */
export interface RedactableSpan {
  attributes?: Record<string, unknown>;
  setAttribute(key: string, value: string): unknown;
}

/**
 * Regrava, redigidos, os atributos de endereço que a instrumentação de HTTP
 * pôs no span. Chamado logo depois de o span ser criado, na requisição que
 * chega e na que sai — muito antes de ele ser exportado.
 */
export function redactUrlAttributes(span: RedactableSpan): void {
  const attributes = span.attributes;
  if (!attributes) return;
  for (const key of QUERY_ATTRIBUTES) {
    const value = attributes[key];
    if (typeof value === 'string') span.setAttribute(key, redactQueryString(value));
  }
  for (const key of URL_ATTRIBUTES) {
    const value = attributes[key];
    if (typeof value === 'string') span.setAttribute(key, redactUrl(value));
  }
}

const SCRIPT_HASH = /^[0-9a-f]{40}$/i;

/**
 * Texto de um comando Redis para o trace: o nome e quantos argumentos, nunca
 * os argumentos. Chaves ficam de fora junto com os valores — a chave de um
 * job é o id dele, e o id do job de entrada é o identificador da mensagem no
 * WhatsApp, que embute o telefone de quem escreveu.
 *
 * Única exceção: o hash de um `evalsha`, que diz qual script rodou (enfileirar,
 * concluir, repetir…) e não carrega dado nenhum.
 */
export function serializeRedisCommand(cmdName: string, cmdArgs: readonly unknown[]): string {
  const total = cmdArgs.length;
  if (total === 0) return cmdName;
  const first = cmdArgs[0];
  if (/^evalsha(_ro)?$/i.test(cmdName) && typeof first === 'string' && SCRIPT_HASH.test(first)) {
    return total === 1 ? `${cmdName} ${first}` : `${cmdName} ${first} [${total - 1} other arguments]`;
  }
  return `${cmdName} [${total} arguments]`;
}
