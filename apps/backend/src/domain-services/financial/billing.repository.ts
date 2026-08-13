import { Billing } from '@domain/billing/billing.entity';

export interface BillingRepository {
  findById(id: string): Promise<Billing | null>;
  findAllByTenant(params?: { cursor?: string; limit?: number }): Promise<Billing[]>;
  save(billing: Billing): Promise<void>;
  linkSessions(billingId: string, sessionIds: string[]): Promise<void>;
  /** Módulo 13 — base da régua de inadimplência e da segmentação financeira. */
  findOverdueByTenant(): Promise<Billing[]>;
  /** Fecha a dívida do M11: quantas sessões estão vinculadas a esta cobrança (billing_session). */
  countLinkedSessions(billingId: string): Promise<number>;
  /**
   * AD-009 — recupera os `sessionId`s vinculados a esta cobrança
   * (`billing_session`), para transicionar as Sessions correspondentes.
   * Método mínimo necessário — não expande `linkSessions()`/
   * `countLinkedSessions()`, só complementa com a leitura que faltava.
   */
  findSessionIdsByBillingId(billingId: string): Promise<string[]>;
  /** Epic 11 — contagem agregada no banco (status='atrasada'), para GET /dashboard/summary. */
  countOverdueByTenant(): Promise<number>;
  /** Epic 11 — soma agregada no banco (exclui quitada/cancelada), para GET /dashboard/summary. */
  sumPendingByTenant(): Promise<number>;
}

export const BILLING_REPOSITORY = Symbol('BILLING_REPOSITORY');
