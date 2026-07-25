import path from 'node:path';
import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.config';

/**
 * Config exclusiva da Suíte Crítica (Etapa 2 da correção de estabilidade —
 * causa B, pressão de conexões). Estende apps/backend/vitest.config.ts
 * (mesmos aliases, mesmo plugin swc) sem alterá-lo — test:unit e
 * test:integration continuam usando a config base, sem globalSetup nem
 * limite de workers.
 *
 * maxWorkers=6: limita quantos arquivos de test/critical o Vitest processa
 * em paralelo. Cada arquivo abre até 2 pools de conexão Prisma (ver
 * support/global-setup.ts). Combinado com connection_limit=4 (aplicado lá),
 * o teto teórico de conexões simultâneas cai de ~650 (26 pools × 25, sem
 * nenhum limite) para no máximo 6 workers × 2 pools × 4 = 48 — bem abaixo
 * de max_connections=100, com margem de segurança confortável mesmo se o
 * Vitest, por algum motivo, chegar a processar mais de 6 arquivos com
 * sobreposição real.
 *
 * minWorkers precisa ser definido explicitamente junto — sem isso o
 * Tinypool calcula o mínimo a partir do default da base (numCpus-1, 11
 * nesta máquina), que passa a ser maior que o maxWorkers=6 configurado
 * aqui, e falha com "options.minThreads and options.maxThreads must not
 * conflict" (erro real encontrado ao rodar pela primeira vez).
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      globalSetup: [path.resolve(__dirname, './support/global-setup.ts')],
      minWorkers: 1,
      maxWorkers: 6,
    },
  }),
);
