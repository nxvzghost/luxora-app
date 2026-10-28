/**
 * As 7 restrições da migration 20261023220000_k11_ai_confirmed_requests
 * (ADR-0069, K11; decisões D1, D2 e D4 de 23/10/2026) — a mesma lista que
 * infra/scripts/lib.sh (K11_CONSTRAINTS) confere antes de subir qualquer
 * versão que declare appointment-ai-confirmation-v1.
 *
 * Usada pela guarda de CI de k11-whatsapp-request-flow.test.ts (existem e
 * estão validadas) e por k11-ai-confirmation-constraints.test.ts (cada uma
 * recusa a linha que a viola).
 */
export const K11_CONSTRAINTS = [
  'appointment_notice_confirms_fkey',
  'appointment_notice_conversation_fkey',
  'appointment_notice_reply_check',
  'appointment_notice_request_check',
  'appointment_outcome_actor_check',
  'appointment_outcome_confirmation_fkey',
  'appointment_outcome_request_fkey',
] as const;

export type K11Constraint = (typeof K11_CONSTRAINTS)[number];
