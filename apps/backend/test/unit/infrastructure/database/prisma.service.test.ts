import { describe, it, expect, vi } from 'vitest';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { TenantContext } from '@shared/tenant-context';

const VALID_TENANT_ID = '11111111-1111-1111-1111-111111111111';

function mockClientProvider() {
  const executeRawUnsafe = vi.fn().mockResolvedValue(undefined);
  const $transaction = vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ $executeRawUnsafe: executeRawUnsafe }),
  );
  return { $transaction, executeRawUnsafe };
}

describe('PrismaService', () => {
  describe('forTenant', () => {
    it('executa SET LOCAL app.tenant_id com o UUID do TenantContext', async () => {
      const clientProvider = mockClientProvider();
      const tenantContext = new TenantContext();
      tenantContext.set(VALID_TENANT_ID, 'user-1');

      // @ts-expect-error — mock simplificado, só o necessário para o teste
      const service = new PrismaService(clientProvider, tenantContext);

      await service.forTenant(async () => 'resultado');

      expect(clientProvider.executeRawUnsafe).toHaveBeenCalledWith(
        `SET LOCAL app.tenant_id = '${VALID_TENANT_ID}'`,
      );
    });

    it('rejeita tenantId em formato inválido antes de tocar o banco (defesa contra injeção)', async () => {
      const clientProvider = mockClientProvider();
      const tenantContext = new TenantContext();
      tenantContext.set("'; DROP TABLE patient; --", 'user-1');

      // @ts-expect-error — mock simplificado
      const service = new PrismaService(clientProvider, tenantContext);

      await expect(service.forTenant(async () => 'nunca deveria rodar')).rejects.toThrow(
        /formato inválido/,
      );
      expect(clientProvider.$transaction).not.toHaveBeenCalled();
    });

    it('lança erro se TenantContext nunca foi inicializado (JwtAuthGuard não rodou)', async () => {
      const clientProvider = mockClientProvider();
      const tenantContext = new TenantContext(); // nunca chamou .set()

      // @ts-expect-error — mock simplificado
      const service = new PrismaService(clientProvider, tenantContext);

      await expect(service.forTenant(async () => 'nunca deveria rodar')).rejects.toThrow();
    });

    it('retorna o valor produzido pela função passada', async () => {
      const clientProvider = mockClientProvider();
      const tenantContext = new TenantContext();
      tenantContext.set(VALID_TENANT_ID, 'user-1');

      // @ts-expect-error — mock simplificado
      const service = new PrismaService(clientProvider, tenantContext);

      const result = await service.forTenant(async () => ({ ok: true }));
      expect(result).toEqual({ ok: true });
    });
  });

  describe('forAuthLookup', () => {
    it('executa SET LOCAL app.bypass_tenant_check, nunca app.tenant_id', async () => {
      const clientProvider = mockClientProvider();
      const tenantContext = new TenantContext(); // deliberadamente não inicializado — login não precisa dele

      // @ts-expect-error — mock simplificado
      const service = new PrismaService(clientProvider, tenantContext);

      await service.forAuthLookup(async () => 'resultado');

      expect(clientProvider.executeRawUnsafe).toHaveBeenCalledWith(
        `SET LOCAL app.bypass_tenant_check = 'true'`,
      );
    });

    it('funciona mesmo sem TenantContext inicializado — é o único método com essa permissão', async () => {
      const clientProvider = mockClientProvider();
      const tenantContext = new TenantContext();

      // @ts-expect-error — mock simplificado
      const service = new PrismaService(clientProvider, tenantContext);

      await expect(service.forAuthLookup(async () => 'ok')).resolves.toBe('ok');
    });
  });
});
