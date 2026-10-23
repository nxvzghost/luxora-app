/**
 * As 23 restrições da migration 20261023130014_k2b_appointment_outcome
 * (ADR-0069, seções 2.7 e 3.7) — a mesma lista que infra/scripts/lib.sh
 * (K2B_CONSTRAINTS) confere antes de subir qualquer versão.
 *
 * Usada pela guarda de CI de appointment-outcome-k2b.test.ts (existem e estão
 * validadas) e por appointment-outcome-k2b-constraints.test.ts (cada uma
 * recusa a linha que a viola).
 */
export const K2B_CONSTRAINTS = [
  'appointment_decision_outcome_fkey',
  'appointment_decision_reason_check',
  'appointment_notice_actor_check',
  'appointment_notice_appointment_fkey',
  'appointment_notice_limit_check',
  'appointment_notice_reference_check',
  'appointment_notice_review_check',
  'appointment_notice_timing_check',
  'appointment_outcome_closing_notice_check',
  'appointment_outcome_closing_notice_fkey',
  'appointment_outcome_closing_timing_check',
  'appointment_outcome_freeze_fkey',
  'appointment_outcome_late_notice_decided_check',
  'appointment_outcome_late_notice_decision_check',
  'appointment_outcome_no_show_decided_check',
  'appointment_outcome_no_show_decision_check',
  'appointment_outcome_state_check',
  'appointment_rescheduled_from_fkey',
  'billing_session_legacy_or_eligibility_check',
  'billing_session_required_eligibility_check',
  'billing_session_session_eligibility_fkey',
  'session_billing_eligibility_check',
  'session_void_check',
] as const;

export type K2bConstraint = (typeof K2B_CONSTRAINTS)[number];
