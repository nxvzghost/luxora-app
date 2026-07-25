import { describe, it, expect } from 'vitest';
import { getPlanBenefits, PLAN_BENEFITS } from '@domain-services/subscription/plan-benefits';

describe('getPlanBenefits', () => {
  it('retorna os benefícios configurados para os planos legados', () => {
    expect(getPlanBenefits('professional').maxTherapists).toBe(1);
    expect(getPlanBenefits('business').maxTherapists).toBe(1);
    expect(getPlanBenefits('enterprise').maxTherapists).toBe(5);
  });

  it('lança erro claro para individual (Priority 5 — estrutura sem benefícios configurados)', () => {
    expect(() => getPlanBenefits('individual')).toThrow(/Benefícios do plano "individual" ainda não configurados/);
  });

  it('lança erro claro para completo', () => {
    expect(() => getPlanBenefits('completo')).toThrow(/Benefícios do plano "completo" ainda não configurados/);
  });

  it('PLAN_BENEFITS não tem entrada para individual/completo (ausência deliberada, não esquecimento)', () => {
    expect(PLAN_BENEFITS.individual).toBeUndefined();
    expect(PLAN_BENEFITS.completo).toBeUndefined();
  });
});
