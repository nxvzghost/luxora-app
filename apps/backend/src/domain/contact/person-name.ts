/**
 * Nome de pessoa em forma comparável — ADR-0063 (AD-037).
 *
 * Sem acento, em minúsculas e com espaços simples: "  João  da SILVA " e
 * "joao da silva" são o mesmo nome. Serve só para comparar; o nome gravado
 * continua como a pessoa o escreveu.
 */
export function normalizePersonName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const NAME_PART = /^[a-z'’-]{2,}$/;

/**
 * "Nome completo" para abrir um cadastro: ao menos nome e sobrenome, só
 * letras (com hífen ou apóstrofo), cada parte com duas letras ou mais. Um
 * prenome sozinho, uma inicial ou um texto com números não é nome completo.
 */
export function isFullName(name: string): boolean {
  const parts = normalizePersonName(name).split(' ');
  return parts.length >= 2 && parts.every((part) => NAME_PART.test(part));
}
