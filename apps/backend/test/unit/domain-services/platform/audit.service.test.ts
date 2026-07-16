import { describe, it, expect, vi } from 'vitest';
import { AuditService } from '@domain-services/platform/audit.service';
import { PatientStateChangedEvent } from '@domain/patient/patient.entity';
import { TenantContext } from '@shared/tenant-context';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

describe('AuditService', () => {
  it('persiste um evento de domínio como registro de auditoria', async () => {
    const repo = { record: vi.fn().mockResolvedValue(undefined), findByTenant: vi.fn() };
    const tenantContext = new TenantContext();
    tenantContext.set(TENANT_ID, 'user-1');
    const service = new AuditService(repo, tenantContext);

    const event = new PatientStateChangedEvent('p1', TENANT_ID, 'Novo', 'Identificado');
    await service.recordAll([event]);

    expect(repo.record).toHaveBeenCalledOnce();
    const call = repo.record.mock.calls[0][0];
    expect(call.action).toBe('PacienteEstadoAlterado');
    expect(call.entityId).toBe('p1');
    expect(call.tenantId).toBe(TENANT_ID);
    expect(call.result).toBe('success');
  });

  it('actorType padrão é user, com userId do TenantContext', async () => {
    const repo = { record: vi.fn().mockResolvedValue(undefined), findByTenant: vi.fn() };
    const tenantContext = new TenantContext();
    tenantContext.set(TENANT_ID, 'user-42');
    const service = new AuditService(repo, tenantContext);

    await service.recordAll([new PatientStateChangedEvent('p1', TENANT_ID, 'Novo', 'Identificado')]);

    const call = repo.record.mock.calls[0][0];
    expect(call.actorType).toBe('user');
    expect(call.userId).toBe('user-42');
  });

  it('actorType ai_agent nunca associa userId (RN-018/019 — auditável separadamente de ações humanas)', async () => {
    const repo = { record: vi.fn().mockResolvedValue(undefined), findByTenant: vi.fn() };
    const tenantContext = new TenantContext();
    const service = new AuditService(repo, tenantContext);

    await service.recordAll([new PatientStateChangedEvent('p1', TENANT_ID, 'Novo', 'Identificado')], 'ai_agent');

    const call = repo.record.mock.calls[0][0];
    expect(call.actorType).toBe('ai_agent');
    expect(call.userId).toBeNull();
  });

  it('persiste múltiplos eventos em sequência', async () => {
    const repo = { record: vi.fn().mockResolvedValue(undefined), findByTenant: vi.fn() };
    const tenantContext = new TenantContext();
    tenantContext.set(TENANT_ID, 'user-1');
    const service = new AuditService(repo, tenantContext);

    await service.recordAll([
      new PatientStateChangedEvent('p1', TENANT_ID, 'Novo', 'Identificado'),
      new PatientStateChangedEvent('p1', TENANT_ID, 'Identificado', 'Cadastrado'),
    ]);

    expect(repo.record).toHaveBeenCalledTimes(2);
  });

  it('lista vazia não chama o Repository', async () => {
    const repo = { record: vi.fn(), findByTenant: vi.fn() };
    const service = new AuditService(repo, new TenantContext());
    await service.recordAll([]);
    expect(repo.record).not.toHaveBeenCalled();
  });
});
