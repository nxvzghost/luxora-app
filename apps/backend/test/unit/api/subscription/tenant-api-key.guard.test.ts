import { describe, it, expect, vi } from 'vitest';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TenantApiKeyGuard } from '@api/subscription/tenant-api-key.guard';
import { ClinicSubscription, PlanTier } from '@domain/subscription/clinic-subscription.entity';
import { TenantContext } from '@shared/tenant-context';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const SECRET = 'a-plaintext-secret-only-used-in-tests';
const HASHED = createHash('sha256').update(SECRET).digest('hex');

function makeGuard(options: {
  storedHash?: string;
  plan?: PlanTier | null;
  header?: string;
}) {
  const { storedHash = HASHED, plan = 'business', header = SECRET } = options;
  const findUnique = vi.fn(({ where: { hashedKey } }: { where: { hashedKey: string } }) =>
    hashedKey === storedHash ? { tenantId: TENANT_ID, hashedKey: storedHash } : null,
  );
  const prisma = {
    forAuthLookup: vi.fn((fn: (tx: unknown) => unknown) => fn({ tenantApiKey: { findUnique } })),
  } as never;
  const subscription = plan
    ? ClinicSubscription.reconstitute({ id: 's1', tenantId: TENANT_ID, plan, billingCycle: 'monthly', status: 'Active' })
    : null;
  const subscriptionRepo = {
    findByTenantId: vi.fn().mockResolvedValue(subscription),
    findByAsaasSubscriptionId: vi.fn(),
    save: vi.fn(),
  };
  const tenantContext = new TenantContext();
  const guard = new TenantApiKeyGuard(prisma, subscriptionRepo, tenantContext);
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ headers: header ? { 'x-api-key': header } : {} }) }),
  } as unknown as ExecutionContext;
  return { guard, context, tenantContext };
}

describe('TenantApiKeyGuard', () => {
  it('libera acesso com chave válida e plano com externalApiAccess, e injeta tenantId com userId null no TenantContext', async () => {
    const { guard, context, tenantContext } = makeGuard({ plan: 'business' });
    expect(await guard.canActivate(context)).toBe(true);
    expect(tenantContext.tenantId).toBe(TENANT_ID);
    expect(tenantContext.userId).toBeNull();
  });

  it('libera acesso no plano enterprise', async () => {
    const { guard, context } = makeGuard({ plan: 'enterprise' });
    expect(await guard.canActivate(context)).toBe(true);
  });

  it('rejeita quando o header X-API-Key está ausente', async () => {
    const { guard, context } = makeGuard({ header: '' });
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejeita quando o hash não corresponde a nenhuma chave salva', async () => {
    const { guard, context } = makeGuard({ storedHash: 'outro-hash-qualquer' });
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejeita no plano Professional, mesmo com chave válida (rebaixamento de plano invalida a chave sem revogação manual)', async () => {
    const { guard, context } = makeGuard({ plan: 'professional' });
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('rejeita quando não há assinatura para o Tenant', async () => {
    const { guard, context } = makeGuard({ plan: null });
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });
});
