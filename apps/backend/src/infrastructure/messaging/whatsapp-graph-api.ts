/**
 * Versão da Graph API da Meta usada pelo backend — ÚNICO ponto de definição.
 *
 * Fase 3B da auditoria — ACHADO REAL: o provider pedia `v19.0`, expirada em
 * 21/05/2026. A Meta não devolve erro para versão expirada: atende com a
 * mais antiga ainda disponível, que muda sozinha a cada expiração. O código
 * achava que falava com uma versão e falava com outra.
 *
 * Por que `v21.0`: é a versão que a Meta vinha servindo para as nossas
 * chamadas (medido em 05/10/2026, cabeçalho `facebook-api-version`), ou
 * seja, a única contra a qual este código já foi de fato exercitado. Fixá-la
 * torna explícito o que já acontecia, sem mudar o comportamento.
 *
 * Como trocar de versão:
 *   1. alterar as duas constantes abaixo, com a data de expiração da tabela
 *      oficial (developers.facebook.com/docs/graph-api/changelog/versions);
 *   2. rodar `EXTERNAL_SMOKE=1 pnpm --filter @luxora/backend test:manual`,
 *      que confere se a Meta serve exatamente a versão pedida.
 *
 * `test/unit/infrastructure/messaging/whatsapp-graph-api.test.ts` falha
 * quando a data de expiração chega — de propósito, para a versão nunca
 * voltar a expirar em silêncio — e quando outro arquivo de `src/` escreve
 * uma versão da Graph API por conta própria.
 */
export const WHATSAPP_GRAPH_API_VERSION = 'v21.0';

/** Último dia em que a Meta serve a versão acima (tabela oficial de versões). Formato AAAA-MM-DD. */
export const WHATSAPP_GRAPH_API_VERSION_EXPIRES_ON = '2027-01-21';

export const WHATSAPP_GRAPH_API_URL = `https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}`;
