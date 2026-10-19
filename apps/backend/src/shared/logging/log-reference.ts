import { createHash } from 'node:crypto';

/**
 * logReference — A-18 da auditoria (19/10/2026).
 *
 * Os ids de job das filas do WhatsApp não podem ir para o log como estão:
 * na entrada o id É o identificador da mensagem na Meta (wamid), que embute
 * o telefone de quem escreveu, e na saída a chave de idempotência carrega o
 * mesmo wamid (`conversation-reply-<wamid>`). O log passa a levar só uma
 * referência opaca e estável: o mesmo id gera sempre a mesma referência, o
 * que basta para seguir um job nos logs; para chegar ao job, calcula-se a
 * referência do id conhecido (`logReference(id)`) e procura-se no log.
 *
 * Não é segredo nem anonimização forte: quem já tem o id consegue confirmar
 * a referência. O objetivo é só não escrever o telefone no log.
 */
export function logReference(id: string | number | null | undefined): string {
  if (id === null || id === undefined || id === '') return 'ref:-';
  return `ref:${createHash('sha256').update(String(id)).digest('hex').slice(0, 12)}`;
}
