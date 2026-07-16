import { describe, it, expect } from 'vitest';
import { ClinicSubscription } from '@domain/subscription/clinic-subscription.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function newSubscription(plan: 'professional' | 'business' | 'enterprise' = 'professional', billingCycle: 'monthly' | 'yearly' = 'monthly') {
  return ClinicSubscription.create({ id: 's1', tenantId: TENANT_ID, plan, billingCycle });
}

describe('ClinicSubscription', () => {
  it('nasce no estado Trialing', () => {
    expect(newSubscription().status).toBe('Trialing');
  });

  it('percorre o fluxo feliz: Trialing → Active → PastDue → Active (regularizado)', () => {
    const s = newSubscription();
    s.transitionTo('Active');
    s.transitionTo('PastDue');
    s.transitionTo('Active');
    expect(s.status).toBe('Active');
  });

  it('Cancelled é estado terminal', () => {
    const s = newSubscription();
    s.transitionTo('Cancelled');
    expect(() => s.transitionTo('Active')).toThrow();
  });

  it('hasActiveAccess é true em Trialing e Active, false em PastDue e Cancelled', () => {
    const trialing = newSubscription();
    expect(trialing.hasActiveAccess).toBe(true);

    const active = newSubscription();
    active.transitionTo('Active');
    expect(active.hasActiveAccess).toBe(true);

    const pastDue = newSubscription();
    pastDue.transitionTo('Active');
    pastDue.transitionTo('PastDue');
    expect(pastDue.hasActiveAccess).toBe(false);

    const cancelled = newSubscription();
    cancelled.transitionTo('Cancelled');
    expect(cancelled.hasActiveAccess).toBe(false);
  });

  describe('amountPerCycle — preços oficiais e desconto anual de 10%', () => {
    it('Professional mensal: R$597', () => {
      expect(newSubscription('professional', 'monthly').amountPerCycle).toBe(597);
    });

    it('Professional anual: R$6.447,60 (597 × 12 × 0,9)', () => {
      expect(newSubscription('professional', 'yearly').amountPerCycle).toBeCloseTo(6447.6, 1);
    });

    it('Business anual: R$10.767,60', () => {
      expect(newSubscription('business', 'yearly').amountPerCycle).toBeCloseTo(10767.6, 1);
    });

    it('Enterprise anual: R$32.292,00', () => {
      expect(newSubscription('enterprise', 'yearly').amountPerCycle).toBeCloseTo(32292.0, 1);
    });
  });

  it('linkToAsaas armazena os IDs do lado Asaas', () => {
    const s = newSubscription();
    s.linkToAsaas('cus_123', 'sub_456');
    expect(s.asaasCustomerId).toBe('cus_123');
    expect(s.asaasSubscriptionId).toBe('sub_456');
  });

  it('emite evento a cada transição', () => {
    const s = newSubscription();
    s.transitionTo('Active');
    const events = s.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe('AssinaturaEstadoAlterado');
  });

  it('reconstitute recria a partir de estado salvo', () => {
    const s = ClinicSubscription.reconstitute({
      id: 's2',
      tenantId: TENANT_ID,
      plan: 'business',
      billingCycle: 'monthly',
      status: 'Active',
      asaasCustomerId: 'cus_1',
      asaasSubscriptionId: 'sub_1',
    });
    expect(s.status).toBe('Active');
    expect(s.plan).toBe('business');
  });
});
