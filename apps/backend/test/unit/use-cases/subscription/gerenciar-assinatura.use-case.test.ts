import { describe, it, expect, vi } from 'vitest';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { UpgradeAssinaturaUseCase, DowngradeAssinaturaUseCase } from '@use-cases/subscription/gerenciar-assinatura.use-case';
import { ClinicSubscription } from '@domain/subscription/clinic-subscription.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function subscription(plan: 'professional' | 'business' | 'enterprise', status: 'Trialing' | 'Active' | 'PastDue' | 'Cancelled' = 'Active') {
  return ClinicSubscription.reconstitute({ id: 's1', tenantId: TENANT_ID, plan, billingCycle: 'monthly', status });
}

function makeRepo(existing: ClinicSubscription | null) {
  return { findByTenantId: vi.fn().mockResolvedValue(existing), findByAsaasSubscriptionId: vi.fn(), save: vi.fn().mockResolvedValue(undefined) };
}

const auditService = { recordAll: vi.fn().mockResolvedValue(undefined) } as never;

describe('UpgradeAssinaturaUseCase', () => {
  it('aplica a troca de plano imediatamente e persiste', async () => {
    const repo = makeRepo(subscription('professional'));
    const useCase = new UpgradeAssinaturaUseCase(repo, auditService);

    const result = await useCase.execute({ tenantId: TENANT_ID, newPlan: 'business' });

    expect(result.plan).toBe('business');
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it('lança NotFoundException se não existe assinatura para o Tenant', async () => {
    const repo = makeRepo(null);
    const useCase = new UpgradeAssinaturaUseCase(repo, auditService);

    await expect(useCase.execute({ tenantId: TENANT_ID, newPlan: 'business' })).rejects.toThrow(NotFoundException);
  });
});

describe('DowngradeAssinaturaUseCase', () => {
  function makeUseCase(existingSubscription: ClinicSubscription | null, activeTherapistsCount: number) {
    const repo = makeRepo(existingSubscription);
    const therapistRepo = {
      findById: vi.fn(),
      findAllByTenant: vi.fn().mockResolvedValue(Array.from({ length: activeTherapistsCount }, (_, i) => ({ id: `t${i}` }))),
      save: vi.fn(),
    } as never;
    return { useCase: new DowngradeAssinaturaUseCase(repo, therapistRepo, auditService), repo };
  }

  it('agenda o downgrade (pendingPlan) sem alterar o plano ativo imediatamente, quando elegível', async () => {
    const { useCase, repo } = makeUseCase(subscription('enterprise'), 1);

    const result = await useCase.execute({ tenantId: TENANT_ID, newPlan: 'professional' });

    expect(result.plan).toBe('enterprise'); // inalterado
    expect(result.pendingPlan).toBe('professional'); // agendado
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it('rejeita o downgrade se a clínica tem mais terapeutas ativos que o teto do plano alvo', async () => {
    // professional/business: maxTherapists = 1 (PLAN_BENEFITS)
    const { useCase } = makeUseCase(subscription('enterprise'), 2);

    await expect(useCase.execute({ tenantId: TENANT_ID, newPlan: 'professional' })).rejects.toThrow(ConflictException);
  });

  it('erro de elegibilidade usa o código SUBSCRIPTION_DOWNGRADE_NOT_ELIGIBLE', async () => {
    const { useCase } = makeUseCase(subscription('enterprise'), 3);

    try {
      await useCase.execute({ tenantId: TENANT_ID, newPlan: 'business' });
      expect.fail('deveria ter lançado');
    } catch (e) {
      expect((e as ConflictException).getResponse()).toMatchObject({ code: 'SUBSCRIPTION_DOWNGRADE_NOT_ELIGIBLE' });
    }
  });

  it('permite downgrade para enterprise mesmo com vários terapeutas (teto de 5)', async () => {
    const { useCase } = makeUseCase(subscription('enterprise'), 5);

    await expect(useCase.execute({ tenantId: TENANT_ID, newPlan: 'enterprise' })).resolves.toBeDefined();
  });

  it('lança NotFoundException se não existe assinatura para o Tenant', async () => {
    const { useCase } = makeUseCase(null, 0);

    await expect(useCase.execute({ tenantId: TENANT_ID, newPlan: 'professional' })).rejects.toThrow(NotFoundException);
  });
});
