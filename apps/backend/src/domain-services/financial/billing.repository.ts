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
}

export const BILLING_REPOSITORY = Symbol('BILLING_REPOSITORY');
