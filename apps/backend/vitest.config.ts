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
