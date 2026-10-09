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

  describe('inUnitOfWork — ADR-0063 (AD-038)', () => {
    function unitOfWorkProvider() {
      const tx = { $executeRawUnsafe: vi.fn().mockResolvedValue(undefined) };
      const $transaction = vi.fn().mockImplementation(async (fn: (client: unknown) => unknown) => fn(tx));
      return { $transaction, tx };
    }

    function serviceFor(clientProvider: unknown, tenantId = VALID_TENANT_ID) {
      const tenantContext = new TenantContext();
      tenantContext.set(tenantId, 'user-1');
      // @ts-expect-error — mock simplificado
      return new PrismaService(clientProvider, tenantContext);
    }

    it('abre UMA transação, define a clínica e devolve o que o trabalho devolver', async () => {
      const clientProvider = unitOfWorkProvider();
      const service = serviceFor(clientProvider);

      const result = await service.inUnitOfWork(async () => 'resultado');

      expect(result).toBe('resultado');
      expect(clientProvider.$transaction).toHaveBeenCalledTimes(1);
      expect(clientProvider.tx.$executeRawUnsafe).toHaveBeenCalledWith(`SET LOCAL app.tenant_id = '${VALID_TENANT_ID}'`);
    });

    it('forTenant() chamado lá dentro entra na mesma transação — por qualquer instância de PrismaService da mesma clínica', async () => {
      const clientProvider = unitOfWorkProvider();
      const otherModuleProvider = unitOfWorkProvider();
      const service = serviceFor(clientProvider);
      // Cada módulo tem o seu PrismaService (e o seu cliente): o repositório de
      // auditoria e o de contatos são instâncias diferentes.
      const otherModuleService = serviceFor(otherModuleProvider);

      const seen: unknown[] = [];
      await service.inUnitOfWork(async () => {
        await service.forTenant(async (tx) => seen.push(tx));
        await otherModuleService.forTenant(async (tx) => seen.push(tx));
      });

      expect(seen).toEqual([clientProvider.tx, clientProvider.tx]);
      expect(clientProvider.$transaction).toHaveBeenCalledTimes(1);
      expect(otherModuleProvider.$transaction).not.toHaveBeenCalled();
    });

    it('fora dela, forTenant() volta a abrir a própria transação — antes e depois', async () => {
      const clientProvider = unitOfWorkProvider();
      const service = serviceFor(clientProvider);

      expect(service.isInUnitOfWork).toBe(false);
      await service.forTenant(async () => undefined);
      await service.inUnitOfWork(async () => {
        expect(service.isInUnitOfWork).toBe(true);
      });
      expect(service.isInUnitOfWork).toBe(false);
      await service.forTenant(async () => undefined);

      expect(clientProvider.$transaction).toHaveBeenCalledTimes(3);
    });

    it('um PrismaService de OUTRA clínica não entra na unidade de trabalho aberta', async () => {
      const clientProvider = unitOfWorkProvider();
      const service = serviceFor(clientProvider);
      const otherClinic = serviceFor(unitOfWorkProvider(), '22222222-2222-2222-2222-222222222222');

      await expect(
        service.inUnitOfWork(async () => {
          await otherClinic.forTenant(async () => 'nunca deveria rodar');
        }),
      ).rejects.toThrow(/outra clínica/);
    });

    it('se o trabalho lança, o erro sai de dentro da transação — é o que a faz ser desfeita', async () => {
      const clientProvider = unitOfWorkProvider();
      const service = serviceFor(clientProvider);

      await expect(
        service.inUnitOfWork(async () => {
          throw new Error('falha no meio');
        }),
      ).rejects.toThrow('falha no meio');
      await expect(clientProvider.$transaction.mock.results[0].value).rejects.toThrow('falha no meio');
      expect(service.isInUnitOfWork).toBe(false);
    });

    it('uma unidade de trabalho dentro de outra reaproveita a que já está aberta', async () => {
      const clientProvider = unitOfWorkProvider();
      const service = serviceFor(clientProvider);

      const seen: unknown[] = [];
      await service.inUnitOfWork(async () => service.inUnitOfWork(async () => service.forTenant(async (tx) => seen.push(tx))));

      expect(seen).toEqual([clientProvider.tx]);
      expect(clientProvider.$transaction).toHaveBeenCalledTimes(1);
    });

    it('rejeita tenantId em formato inválido antes de tocar o banco', async () => {
      const clientProvider = unitOfWorkProvider();
      const service = serviceFor(clientProvider, "'; DROP TABLE patient; --");

      await expect(service.inUnitOfWork(async () => 'nunca deveria rodar')).rejects.toThrow(/formato inválido/);
      expect(clientProvider.$transaction).not.toHaveBeenCalled();
    });

    it('forAuthLookup() nunca entra na unidade de trabalho: abre sempre a própria transação', async () => {
      const clientProvider = unitOfWorkProvider();
      const service = serviceFor(clientProvider);

      await service.inUnitOfWork(async () => {
        await service.forAuthLookup(async () => undefined);
      });

      expect(clientProvider.$transaction).toHaveBeenCalledTimes(2);
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
