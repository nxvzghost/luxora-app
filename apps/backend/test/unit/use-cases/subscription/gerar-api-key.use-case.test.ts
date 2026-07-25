import { describe, it, expect, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { GerarApiKeyUseCase } from '@use-cases/subscription/gerar-api-key.use-case';
import { ClinicSubscription, PlanTier } from '@domain/subscription/clinic-subscription.entity';
import { TenantContext } from '@shared/tenant-context';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function makeUseCase(plan: PlanTier | null) {
  const subscription = plan
    ? ClinicSubscription.reconstitute({ id: 's1', tenantId: TENANT_ID, plan, billingCycle: 'monthly', status: 'Active' })
    : null;
  const subscriptionRepo = {
    findByTenantId: vi.fn().mockResolvedValue(subscription),
    findByAsaasSubscriptionId: vi.fn(),
    save: vi.fn(),
  };
  const upsert = vi.fn().mockResolvedValue(undefined);
  const prisma = { forTenant: vi.fn((fn: (tx: unknown) => unknown) => fn({ tenantApiKey: { upsert } })) } as never;
  const tenantContext = new TenantContext();
  tenantContext.set(TENANT_ID, 'user-1');
  return { useCase: new GerarApiKeyUseCase(prisma, subscriptionRepo, tenantContext), upsert };
}

describe('GerarApiKeyUseCase', () => {
  it.each(['business', 'enterprise'] as const)('gera uma chave para o plano %s', async (plan) => {
    const { useCase, upsert } = makeUseCase(plan);
    const result = await useCase.execute();

    expect(result.apiKey).toHaveLength(64); // randomBytes(32).toString('hex')
    expect(upsert).toHaveBeenCalledOnce();
    const args = upsert.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: TENANT_ID });
    // O hash salvo precisa bater com o segredo retornado — prova de que
    // não é um valor qualquer, é derivado do mesmo segredo.
    expect(args.create.hashedKey).toBe(createHash('sha256').update(result.apiKey).digest('hex'));
  });

  it('rejeita no plano Professional, com API_ACCESS_NOT_INCLUDED', async () => {
    const { useCase, upsert } = makeUseCase('professional');
    await expect(useCase.execute()).rejects.toThrow(ConflictException);
    expect(upsert).not.toHaveBeenCalled();

    try {
      await useCase.execute();
    } catch (err) {
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: 'API_ACCESS_NOT_INCLUDED',
        category: 'business_rule',
      });
    }
  });

  it('rejeita quando não há assinatura', async () => {
    const { useCase } = makeUseCase(null);
    await expect(useCase.execute()).rejects.toThrow(ConflictException);
  });
});
