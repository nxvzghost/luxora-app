import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConectarWhatsAppUseCase } from '@use-cases/communication/conectar-whatsapp.use-case';
import { TenantContext } from '@shared/tenant-context';
import { TokenCipherService } from '@shared/token-cipher.service';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

describe('ConectarWhatsAppUseCase', () => {
  const ORIGINAL_KEY = process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = 'chave-de-teste-nao-usar-em-producao-2026';
  });

  afterEach(() => {
    process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = ORIGINAL_KEY;
  });

  // AD-005: a credencial nunca é gravada em texto puro — o teste afirma que
  // o valor persistido está no formato versionado do TokenCipherService e,
  // decifrado de volta, é igual ao texto puro original. Não afirma mais
  // igualdade direta com o texto enviado (isso quebraria por design).
  it('salva a credencial da clínica cifrada (AES-256-GCM via TokenCipherService), via upsert, escopado ao Tenant do contexto', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const prisma = { forTenant: vi.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn({ whatsAppIntegration: { upsert } })) };
    const tenantContext = new TenantContext();
    tenantContext.set(TENANT_ID, 'user-1');
    const tokenCipher = new TokenCipherService();

    const useCase = new ConectarWhatsAppUseCase(prisma, tenantContext, tokenCipher);
    await useCase.execute({ phoneNumberId: '123', accessToken: 'token-abc' });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT_ID },
        create: expect.objectContaining({ tenantId: TENANT_ID, phoneNumberId: '123' }),
      }),
    );
    const persistedValue = upsert.mock.calls[0][0].create.accessToken as string;
    expect(persistedValue).not.toBe('token-abc');
    expect(persistedValue.startsWith('v1:')).toBe(true);
    expect(tokenCipher.decrypt(persistedValue)).toBe('token-abc');
  });
});
