import { describe, it, expect, vi } from 'vitest';
import { ConsultarAuditLogUseCase } from '@use-cases/audit/consultar-audit-log.use-case';
import type { AuditLogRepository } from '@domain-services/platform/audit-log.repository';

/**
 * Tarefa 06 da auditoria (AD-022) — caminho de leitura da trilha. O
 * isolamento por clínica e o formato são provados contra o banco real em
 * test/critical/audit-log-read.test.ts; aqui, só o que o caso de uso faz.
 */
const ENTRY = {
  id: 'audit-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
  actorType: 'user',
  action: 'PacienteCadastrado',
  entityType: 'Patient',
  entityId: 'patient-1',
  payload: null,
  result: 'success',
};

function setup(entries: unknown[] = [ENTRY]) {
  const findByTenant = vi.fn().mockResolvedValue(entries);
  const repo = { findByTenant, record: vi.fn(), recordAll: vi.fn() } as unknown as AuditLogRepository;
  return { useCase: new ConsultarAuditLogUseCase(repo), findByTenant };
}

describe('ConsultarAuditLogUseCase', () => {
  it('repassa cursor e limit ao repositório e devolve o que ele encontrou, sem alterar', async () => {
    const { useCase, findByTenant } = setup();

    const result = await useCase.execute({ cursor: 'audit-0', limit: 25 });

    expect(findByTenant).toHaveBeenCalledWith({ cursor: 'audit-0', limit: 25 });
    expect(result).toEqual([ENTRY]);
  });

  it('sem parâmetros, deixa o padrão por conta do repositório', async () => {
    const { useCase, findByTenant } = setup([]);

    expect(await useCase.execute()).toEqual([]);
    expect(findByTenant).toHaveBeenCalledWith(undefined);
  });

  it('só lê: nunca chama uma operação de escrita da trilha', async () => {
    const findByTenant = vi.fn().mockResolvedValue([]);
    const record = vi.fn();
    const recordAll = vi.fn();
    const useCase = new ConsultarAuditLogUseCase({ findByTenant, record, recordAll } as unknown as AuditLogRepository);

    await useCase.execute({ limit: 10 });

    expect(record).not.toHaveBeenCalled();
    expect(recordAll).not.toHaveBeenCalled();
  });
});
