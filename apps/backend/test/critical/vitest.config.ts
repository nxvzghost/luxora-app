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
 * maxWorkers=4: limita quantos arquivos de test/critical o Vitest processa
 * em paralelo. Cada arquivo abre 2 ou 3 pools de conexão Prisma: o da
 * aplicação (bootstrapTestApp(), um só desde o DatabaseModule) e 1 ou 2
 * `new PrismaClient()` diretos para setup/cleanup. Com connection_limit=4
 * (aplicado em support/global-setup.ts), o teto é 4 workers × 3 pools × 4 =
 * 48 conexões, abaixo das 97 que o Postgres deixa para quem não é
 * superusuário (max_connections=100, 3 reservadas).
 *
 * A conta anterior (2 pools por arquivo) estava errada: PrismaClientProvider
 * era declarado em 17 módulos, e cada app de teste tinha 17 pools — até 68
 * conexões só da aplicação, por arquivo. Foi o que esgotou as conexões no CI
 * 39737046589. Agora é uma instância só (DatabaseModule), e
 * test/critical/prisma-client-shared-instance.test.ts prova isso.
 *
 * minWorkers precisa ser definido explicitamente junto — sem isso o
 * Tinypool calcula o mínimo a partir do default da base (numCpus-1, 11
 * nesta máquina), que passa a ser maior que o maxWorkers configurado
 * aqui, e falha com "options.minThreads and options.maxThreads must not
 * conflict" (erro real encontrado ao rodar pela primeira vez).
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      globalSetup: [path.resolve(__dirname, './support/global-setup.ts')],
      minWorkers: 1,
      maxWorkers: 4,
    },
  }),
);
