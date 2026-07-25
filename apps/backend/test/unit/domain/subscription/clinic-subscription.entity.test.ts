import { describe, it, expect } from 'vitest';
import { ClinicSubscription, PlanTier } from '@domain/subscription/clinic-subscription.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function newSubscription(plan: PlanTier = 'professional', billingCycle: 'monthly' | 'yearly' = 'monthly') {
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

  it('hasActiveAccess é true em Trialing e Active, false em Cancelled', () => {
    const trialing = newSubscription();
    expect(trialing.hasActiveAccess).toBe(true);

    const active = newSubscription();
    active.transitionTo('Active');
    expect(active.hasActiveAccess).toBe(true);

    const cancelled = newSubscription();
    cancelled.transitionTo('Cancelled');
    expect(cancelled.hasActiveAccess).toBe(false);
  });

  describe('período de tolerância de 7 dias em PastDue (CEO-DEC-003.1, CEO-DEC-003.2)', () => {
    it('hasActiveAccess é true logo ao entrar em PastDue (dentro do período de tolerância)', () => {
      const s = newSubscription();
      s.transitionTo('Active');
      s.transitionTo('PastDue');
      expect(s.hasActiveAccess).toBe(true);
      expect(s.pastDueSince).toBeInstanceOf(Date);
    });

    it('hasActiveAccess é false quando o período de tolerância de 7 dias já passou', () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const s = ClinicSubscription.reconstitute({
        id: 's3',
        tenantId: TENANT_ID,
        plan: 'professional',
        billingCycle: 'monthly',
        status: 'PastDue',
        pastDueSince: eightDaysAgo,
      });
      expect(s.hasActiveAccess).toBe(false);
    });

    it('hasActiveAccess é false em PastDue sem pastDueSince registrado (falha fechado, dado legado)', () => {
      const s = ClinicSubscription.reconstitute({
        id: 's4',
        tenantId: TENANT_ID,
        plan: 'professional',
        billingCycle: 'monthly',
        status: 'PastDue',
      });
      expect(s.hasActiveAccess).toBe(false);
    });

    it('regularização (PastDue → Active) limpa pastDueSince', () => {
      const s = newSubscription();
      s.transitionTo('Active');
      s.transitionTo('PastDue');
      expect(s.pastDueSince).toBeDefined();
      s.transitionTo('Active');
      expect(s.pastDueSince).toBeUndefined();
    });

    it('Trialing pode transicionar diretamente para PastDue (trial sem confirmação de pagamento)', () => {
      const s = newSubscription();
      expect(() => s.transitionTo('PastDue')).not.toThrow();
      expect(s.status).toBe('PastDue');
      expect(s.hasActiveAccess).toBe(true); // dentro do período de tolerância
    });
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

    it('Enterprise mensal: R$2.490', () => {
      expect(newSubscription('enterprise', 'monthly').amountPerCycle).toBe(2490);
    });

    it('Enterprise anual: R$26.892,00', () => {
      expect(newSubscription('enterprise', 'yearly').amountPerCycle).toBeCloseTo(26892.0, 1);
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

  describe('upgrade e downgrade (CEO-DEC-002.5, CEO-DEC-003.6)', () => {
    it('changePlan troca o plano imediatamente e emite evento', () => {
      const s = newSubscription('professional');
      s.changePlan('business');
      expect(s.plan).toBe('business');
      const events = s.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventName).toBe('AssinaturaPlanoAlterado');
    });

    it('scheduleDowngrade não muda o plano atual, só registra pendingPlan', () => {
      const s = newSubscription('enterprise');
      s.scheduleDowngrade('professional');
      expect(s.plan).toBe('enterprise');
      expect(s.pendingPlan).toBe('professional');
      const events = s.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventName).toBe('AssinaturaDowngradeAgendado');
    });

    it('applyPendingDowngrade efetiva o plano agendado e limpa pendingPlan', () => {
      const s = newSubscription('enterprise');
      s.scheduleDowngrade('professional');
      s.pullDomainEvents();
      s.applyPendingDowngrade();
      expect(s.plan).toBe('professional');
      expect(s.pendingPlan).toBeUndefined();
    });

    it('applyPendingDowngrade sem downgrade agendado não faz nada', () => {
      const s = newSubscription('professional');
      s.applyPendingDowngrade();
      expect(s.plan).toBe('professional');
      expect(s.pullDomainEvents()).toHaveLength(0);
    });
  });

  describe('confirmPayment (CEO-DEC-003.6, ativação e renovação)', () => {
    it('primeira confirmação: Trialing → Active e define currentPeriodEnd', () => {
      const s = newSubscription();
      s.confirmPayment();
      expect(s.status).toBe('Active');
      expect(s.currentPeriodEnd).toBeInstanceOf(Date);
    });

    it('renovação: assinatura já Active permanece Active e currentPeriodEnd avança', () => {
      const s = newSubscription();
      s.confirmPayment();
      const firstPeriodEnd = s.currentPeriodEnd!;
      s.confirmPayment();
      expect(s.status).toBe('Active');
      expect(s.currentPeriodEnd!.getTime()).toBeGreaterThanOrEqual(firstPeriodEnd.getTime());
    });

    it('renovação aplica downgrade agendado automaticamente', () => {
      const s = newSubscription('enterprise');
      s.confirmPayment(); // primeira ativação, sem pendingPlan ainda
      s.scheduleDowngrade('professional');
      s.confirmPayment(); // renovação — deve aplicar o downgrade agendado
      expect(s.plan).toBe('professional');
      expect(s.pendingPlan).toBeUndefined();
    });

    it('primeira confirmação NÃO aplica pendingPlan (não é renovação)', () => {
      // pendingPlan só faz sentido em uma assinatura já paga antes —
      // reconstitute simula um estado impossível de alcançar via create(),
      // só para provar que o guard `isRenewal` funciona corretamente.
      const s = ClinicSubscription.reconstitute({
        id: 's1', tenantId: TENANT_ID, plan: 'enterprise', billingCycle: 'monthly', status: 'Trialing', pendingPlan: 'professional',
      });
      s.confirmPayment();
      expect(s.plan).toBe('enterprise'); // pendingPlan não aplicado
      expect(s.pendingPlan).toBe('professional'); // continua agendado
    });
  });

  describe('Priority 5 — estrutura de Individual/Completo (PD-003, CEO-DEC-002.1)', () => {
    it('individual e completo são valores válidos de PlanTier — a entidade aceita criá-los', () => {
      expect(() => newSubscription('individual')).not.toThrow();
      expect(() => newSubscription('completo')).not.toThrow();
    });

    it('amountPerCycle lança erro claro para individual (preço ainda não definido no Catálogo Comercial)', () => {
      const s = newSubscription('individual');
      expect(() => s.amountPerCycle).toThrow(/Preço do plano "individual" ainda não configurado/);
    });

    it('amountPerCycle lança erro claro para completo', () => {
      const s = newSubscription('completo');
      expect(() => s.amountPerCycle).toThrow(/Preço do plano "completo" ainda não configurado/);
    });

    it('planos legados continuam funcionando sem alteração (compatibilidade preservada)', () => {
      expect(newSubscription('professional').amountPerCycle).toBe(597);
      expect(newSubscription('business').amountPerCycle).toBe(997);
      expect(newSubscription('enterprise').amountPerCycle).toBe(2490);
    });
  });
});
