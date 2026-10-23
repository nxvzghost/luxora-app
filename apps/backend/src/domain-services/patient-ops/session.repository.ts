import { BillingEligibility, Session, SessionKind, SessionState } from '@domain/session/session.entity';

/** Filtro da listagem de sessões (Tarefa 05). Tudo opcional. */
export interface SessionFilter {
  state?: SessionState;
  patientId?: string;
  /**
   * K2-b — só as sessões que podem entrar numa cobrança nova (a faturar,
   * elegíveis e não anuladas). É o que a tela de cobrança oferece.
   */
  billableOnly?: boolean;
  limit?: number;
}

/**
 * Visão de leitura de uma sessão, com a data da consulta que a originou —
 * dado do Appointment, que a entidade Session não carrega. Só para listagem.
 */
export interface SessionSummary {
  id: string;
  appointmentId: string;
  patientId: string;
  therapistId: string;
  state: SessionState;
  scheduledAt: Date;
  /** K2-b — o que a sessão cobra; nulo nas legadas. */
  kind: SessionKind | null;
  billingEligibility: BillingEligibility;
  voidedAt: Date | null;
}

export interface SessionRepository {
  findById(id: string): Promise<Session | null>;
  /** K2-b — a sessão da consulta (`appointment_id` é único), para reaproveitar em vez de recriar. */
  findByAppointmentId(appointmentId: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
  /** Tarefa 05 — sessões da clínica, da consulta mais recente para a mais antiga. */
  findSummaries(filter?: SessionFilter): Promise<SessionSummary[]>;
}

export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY');
