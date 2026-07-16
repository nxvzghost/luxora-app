import { describe, it } from 'vitest';

/**
 * [CRÍTICO #3] Cache (Redis) nunca retorna dado de um Tenant para
 * requisição de outro — docs/02-Arquitetura/07-Multitenancy.md, seção Cache.
 *
 * GAP REAL, NÃO UM TESTE ESQUECIDO: não existe nenhuma camada de cache de
 * dado de aplicação neste código hoje — `src/infrastructure/cache/` está
 * vazio (0 arquivos), nenhum Repository ou Use Case lê/escreve em Redis
 * para cache (Redis aqui só é usado para a fila BullMQ — infrastructure/messaging/,
 * um propósito diferente, sem risco de vazamento de dado por chave de
 * cache mal-escopada). Escrever um teste "passando" aqui seria teatro —
 * não haveria nada de verdade sendo validado.
 *
 * Skip deliberado e documentado, não silencioso: aparece no relatório do
 * CI como pulado, não como verde, então ninguém lê "passou" e assume que
 * cache multi-tenant foi validado. Assim que uma camada de cache real for
 * implementada, este teste deve ser escrito de verdade (chave de cache
 * sempre prefixada por tenant_id, nunca compartilhada entre Tenants) antes
 * de a feature ser considerada pronta.
 */
describe.skip('[CRÍTICO #3] Isolamento multi-tenant no cache', () => {
  it('cache nunca retorna dado de um Tenant para requisição de outro', () => {
    // Intencionalmente vazio — ver comentário acima. Não implementar até
    // que exista uma camada de cache real para testar.
  });
});
