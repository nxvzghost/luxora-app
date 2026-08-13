import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * passWithNoTests: frontend ainda não tem nenhum teste escrito (cobertura é
 * uma lacuna real, não um problema deste config) — sem isso, `vitest run`
 * sai com código 1 e quebra `pnpm test:unit` na raiz e o job de CI mesmo
 * sem nenhum teste ter falhado de verdade.
 *
 * resolve.alias — Fase 9.1 (AD-028), achado real: `@/*` já é o alias
 * usado em todo o código de produção (`tsconfig.json` § paths), mas o
 * Vitest/Vite não lê `tsconfig.json` para isso sozinho — sem este alias
 * espelhado aqui, qualquer teste que importe (direta ou indiretamente) um
 * arquivo de produção com `@/...` falha em tempo de resolução de módulo.
 *
 * environment: 'jsdom' — Fase 9.2 (AD-014), decisão explícita: testes de
 * componente (renderização real de páginas/JSX) exigem DOM. Antes disso,
 * `environment: 'node'` bastava porque só havia testes de lógica pura
 * (store, função de decisão do guard). setupFiles carrega os matchers do
 * @testing-library/jest-dom (ex. toBeInTheDocument()).
 *
 * esbuild.jsx: 'automatic' — achado real: tsconfig.json usa `"jsx":
 * "preserve"` (Next.js transforma o JSX via SWC no próprio build; Vitest
 * nunca vê isso). Sem isto, o esbuild do Vitest assume o runtime clássico
 * de JSX (`React.createElement` implícito, exigindo `React` no escopo do
 * arquivo) — todo teste de componente falhava com "React is not defined",
 * mesmo sem nenhum arquivo de teste importar React explicitamente (o
 * próprio código de produção também não importa, runtime automático).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    passWithNoTests: true,
  },
});
