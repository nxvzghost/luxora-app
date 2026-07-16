/**
 * Formata valor monetário no padrão brasileiro (R$ 12.800,00) — nunca
 * `.toFixed(2)` cru, que produz "R$ 12800.00" (ponto decimal, sem
 * separador de milhar), errado para todo usuário brasileiro.
 */
export function formatCurrencyBRL(value: number): string {
  return value.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}
