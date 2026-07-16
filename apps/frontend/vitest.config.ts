import { defineConfig } from 'vitest/config';

/**
 * passWithNoTests: frontend ainda não tem nenhum teste escrito (cobertura é
 * uma lacuna real, não um problema deste config) — sem isso, `vitest run`
 * sai com código 1 e quebra `pnpm test:unit` na raiz e o job de CI mesmo
 * sem nenhum teste ter falhado de verdade.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    passWithNoTests: true,
  },
});
