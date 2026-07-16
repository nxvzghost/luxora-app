import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Resolve os mesmos path aliases definidos em tsconfig.json, necessário
 * porque o Vitest não lê "paths" do tsconfig automaticamente sem este plugin
 * explícito — sem isso, todo teste que importar de @domain/*, @shared/* etc.
 * falharia na resolução de módulo.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // test/integration/ ainda não tem nenhum arquivo — sem isso, `vitest run
    // test/integration` sai com código 1 ("No test files found") e quebra o
    // job test-integration do CI (e test-critical, que depende dele) mesmo
    // sem nenhum teste ter falhado de verdade. test/unit e test/critical têm
    // arquivos reais; se um dia ficarem vazios por engano, essa config não
    // detecta — risco aceito, mesmo padrão já usado em apps/frontend.
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@domain': path.resolve(__dirname, './src/domain'),
      '@operational-engine': path.resolve(__dirname, './src/operational-engine'),
      '@domain-services': path.resolve(__dirname, './src/domain-services'),
      '@use-cases': path.resolve(__dirname, './src/use-cases'),
      '@infrastructure': path.resolve(__dirname, './src/infrastructure'),
      '@api': path.resolve(__dirname, './src/api'),
      '@shared': path.resolve(__dirname, './src/shared'),
    },
  },
});
