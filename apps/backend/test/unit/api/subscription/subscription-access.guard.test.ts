import { describe, it, expect, vi } from 'vitest';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionAccessGuard } from '@api/subscription/subscription-access.guard';
import { ClinicSubscription } from '@domain/subscription/clinic-subscription.entity';
import { TenantContext } from '@shared/tenant-context';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function makeGuard(skip: boolean, subscription: ClinicSubscription | null, tenantInitialized = true) {
  const reflector = { getAllAndOverride: vi.fn().mockReturnValue(skip) } as unknown as Reflector;
  const repo = { findByTenantId: vi.fn().mockResolvedValue(subscription), findByAsaasSubscriptionId: vi.fn(), save: vi.fn() };
  const tenantContext = new TenantContext();
  if (tenantInitialized) tenantContext.set(TENANT_ID, 'user-1');
  const guard = new SubscriptionAccessGuard(reflector, repo, tenantContext);
  const context = { getHandler: () => ({}), getClass: () => ({}) } as unknown as ExecutionContext;
  return { guard, context };
}

function sub(status: 'Trialing' | 'Active' | 'PastDue' | 'Cancelled') {
  return ClinicSubscription.reconstitute({ id: 's1', tenantId: TENANT_ID, plan: 'professional', billingCycle: 'monthly', status });
}

describe('SubscriptionAccessGuard', () => {
  it('libera acesso quando a rota tem @SkipSubscriptionCheck()', async () => {
    const { guard, context } = makeGuard(true, null);
    expect(await guard.canActivate(context)).toBe(true);
  });

  it('libera acesso quando TenantContext não foi inicializado (rota pública, responsabilidade de outro guard)', async () => {
    const { guard, context } = makeGuard(false, null, false);
    expect(await guard.canActivate(context)).toBe(true);
  });

  it('libera acesso para assinatura Trialing', async () => {
    const { guard, context } = makeGuard(false, sub('Trialing'));
    expect(await guard.canActivate(context)).toBe(true);
  });

  it('libera acesso para assinatura Active', async () => {
    const { guard, context } = makeGuard(false, sub('Active'));
    expect(await guard.canActivate(context)).toBe(true);
  });

  it('bloqueia acesso para assinatura PastDue', async () => {
    const { guard, context } = makeGuard(false, sub('PastDue'));
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('bloqueia acesso para assinatura Cancelled', async () => {
    const { guard, context } = makeGuard(false, sub('Cancelled'));
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('bloqueia acesso quando não existe assinatura nenhuma para o Tenant', async () => {
    const { guard, context } = makeGuard(false, null);
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('erro de bloqueio usa o formato oficial com code SUBSCRIPTION_INACTIVE', async () => {
    const { guard, context } = makeGuard(false, sub('PastDue'));
    try {
      await guard.canActivate(context);
      expect.fail('deveria ter lançado');
    } catch (e) {
      expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'SUBSCRIPTION_INACTIVE' });
    }
  });
});
