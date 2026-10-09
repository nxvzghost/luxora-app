import { it } from 'vitest';

/**
 * Defeito conhecido, ainda não corrigido (decisão de 08/10/2026).
 *
 * Um teste escrito com `knownDefect` afirma o comportamento CORRETO, já
 * decidido — por isso ele FALHA enquanto o defeito existir. Ele nunca conta
 * como aprovado:
 *
 *   - na suíte que libera o CI (`test:critical`) ele não é executado e
 *     aparece como pulado, com o título à vista;
 *   - `pnpm --filter @luxora/backend test:known-defects` executa só esses
 *     testes, de verdade, e termina em falha enquanto houver defeito aberto.
 *
 * O título começa por "DEFEITO CONHECIDO (AD-xxx)", com o item de backlog que
 * corrige o defeito. Corrigido, troque `knownDefect` por `it`: o teste passa
 * a ser uma garantia como as outras.
 *
 * Não use `it.fails`: ele faz o teste contar como aprovado justamente
 * enquanto o defeito existe.
 */
export const knownDefect = process.env.KNOWN_DEFECTS === '1' ? it : it.skip;
