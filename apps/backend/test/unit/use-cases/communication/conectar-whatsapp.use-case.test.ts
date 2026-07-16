import { describe, it, expect, vi } from 'vitest';
import { ConectarWhatsAppUseCase } from '@use-cases/communication/conectar-whatsapp.use-case';
import { TenantContext } from '@shared/tenant-context';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

describe('ConectarWhatsAppUseCase', () => {
  it('salva a credencial da clínica via upsert, escopado ao Tenant do contexto', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const prisma = { forTenant: vi.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn({ whatsAppIntegration: { upsert } })) };
    const tenantContext = new TenantContext();
    tenantContext.set(TENANT_ID, 'user-1');

    const useCase = new ConectarWhatsAppUseCase(prisma, tenantContext);
    await useCase.execute({ phoneNumberId: '123', accessToken: 'token-abc' });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT_ID },
        create: expect.objectContaining({ tenantId: TENANT_ID, phoneNumberId: '123', accessToken: 'token-abc' }),
      }),
    );
  });
});
