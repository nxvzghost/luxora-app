import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { CriarFeriadoUseCase, RemoverFeriadoUseCase, ListarFeriadosUseCase } from '@use-cases/availability/gerenciar-clinic-holiday.use-case';
import { ClinicHoliday } from '@domain/availability/clinic-holiday.entity';
import { TenantContext } from '@shared/tenant-context';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-2222-2222-222222222222';

function tenantContext(tenantId = TENANT_ID) {
  const tc = new TenantContext();
  tc.set(tenantId, 'user-1');
  return tc;
}

function fakeHoliday(tenantId = TENANT_ID) {
  return ClinicHoliday.create({
    id: 'h1',
    tenantId,
    from: new Date('2026-12-25T00:00:00'),
    to: new Date('2026-12-26T00:00:00'),
  });
}

describe('CriarFeriadoUseCase', () => {
  it('cria o feriado com o tenantId do contexto', async () => {
    const repo = { findByTenantAndRange: vi.fn(), save: vi.fn().mockResolvedValue(undefined), findById: vi.fn(), delete: vi.fn() };
    const useCase = new CriarFeriadoUseCase(repo, tenantContext(), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const holiday = await useCase.execute({ from: new Date('2026-12-25T00:00:00'), to: new Date('2026-12-26T00:00:00') });
    expect(holiday.tenantId).toBe(TENANT_ID);
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it('propaga erro de validação da entidade (ex: intervalo inválido)', async () => {
    const repo = { findByTenantAndRange: vi.fn(), save: vi.fn(), findById: vi.fn(), delete: vi.fn() };
    const useCase = new CriarFeriadoUseCase(repo, tenantContext(), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    await expect(
      useCase.execute({ from: new Date('2026-12-26T00:00:00'), to: new Date('2026-12-25T00:00:00') }),
    ).rejects.toThrow(/anterior ao fim/);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('auditoria (revisão pós-B5): registra FeriadoClinicaCriado após save(), nunca antes', async () => {
    const calls: string[] = [];
    const repo = {
      findByTenantAndRange: vi.fn(),
      save: vi.fn().mockImplementation(async () => {
        calls.push('save');
      }),
      findById: vi.fn(),
      delete: vi.fn(),
    };
    const recordAll = vi.fn().mockImplementation(async () => {
      calls.push('recordAll');
    });
    const useCase = new CriarFeriadoUseCase(repo, tenantContext(), { recordAll } as never);
    await useCase.execute({ from: new Date('2026-12-25T00:00:00'), to: new Date('2026-12-26T00:00:00'), reason: 'natal' });

    expect(calls).toEqual(['save', 'recordAll']);
    expect(recordAll).toHaveBeenCalledOnce();
    const events = recordAll.mock.calls[0][0];
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe('FeriadoClinicaCriado');
    expect(events[0].tenantId).toBe(TENANT_ID);
  });

  it('validação inválida nunca dispara recordAll()', async () => {
    const recordAll = vi.fn();
    const repo = { findByTenantAndRange: vi.fn(), save: vi.fn(), findById: vi.fn(), delete: vi.fn() };
    const useCase = new CriarFeriadoUseCase(repo, tenantContext(), { recordAll } as never);
    await expect(
      useCase.execute({ from: new Date('2026-12-26T00:00:00'), to: new Date('2026-12-25T00:00:00') }),
    ).rejects.toThrow();
    expect(recordAll).not.toHaveBeenCalled();
  });
});

describe('RemoverFeriadoUseCase', () => {
  it('localiza antes de remover: findById → delete, ambos com o tenantId do contexto', async () => {
    const holiday = fakeHoliday();
    const repo = {
      findByTenantAndRange: vi.fn(),
      save: vi.fn(),
      findById: vi.fn().mockResolvedValue(holiday),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const useCase = new RemoverFeriadoUseCase(repo, tenantContext(), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    await useCase.execute('h1');
    expect(repo.findById).toHaveBeenCalledWith(TENANT_ID, 'h1');
    expect(repo.delete).toHaveBeenCalledWith(TENANT_ID, 'h1');
  });

  it('lança NotFoundException quando o feriado não existe — e nunca chama delete()', async () => {
    const repo = { findByTenantAndRange: vi.fn(), save: vi.fn(), findById: vi.fn().mockResolvedValue(null), delete: vi.fn() };
    const useCase = new RemoverFeriadoUseCase(repo, tenantContext(), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    await expect(useCase.execute('h-inexistente')).rejects.toThrow(NotFoundException);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('lança NotFoundException (não outro erro) ao tentar remover um feriado de outro Tenant — nunca chama delete()', async () => {
    // O mock simula o contrato real de findById: nunca retorna registro de
    // outro tenant, mesmo que o id exista — ver teste crítico dedicado a
    // isso no Repository.
    const repo = {
      findByTenantAndRange: vi.fn(),
      save: vi.fn(),
      findById: vi.fn().mockResolvedValue(null), // tenant do contexto não é o dono do registro
      delete: vi.fn(),
    };
    const useCase = new RemoverFeriadoUseCase(repo, tenantContext(OTHER_TENANT_ID), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    await expect(useCase.execute('h1')).rejects.toThrow(NotFoundException);
    expect(repo.findById).toHaveBeenCalledWith(OTHER_TENANT_ID, 'h1');
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('auditoria (revisão pós-B5): registra FeriadoClinicaRemovido após delete(), nunca antes', async () => {
    const calls: string[] = [];
    const holiday = fakeHoliday();
    const repo = {
      findByTenantAndRange: vi.fn(),
      save: vi.fn(),
      findById: vi.fn().mockResolvedValue(holiday),
      delete: vi.fn().mockImplementation(async () => {
        calls.push('delete');
      }),
    };
    const recordAll = vi.fn().mockImplementation(async () => {
      calls.push('recordAll');
    });
    const useCase = new RemoverFeriadoUseCase(repo, tenantContext(), { recordAll } as never);
    await useCase.execute('h1');

    expect(calls).toEqual(['delete', 'recordAll']);
    expect(recordAll).toHaveBeenCalledOnce();
    const events = recordAll.mock.calls[0][0];
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe('FeriadoClinicaRemovido');
    expect(events[0].entityId).toBe('h1');
  });

  it('NotFoundException nunca dispara recordAll()', async () => {
    const recordAll = vi.fn();
    const repo = { findByTenantAndRange: vi.fn(), save: vi.fn(), findById: vi.fn().mockResolvedValue(null), delete: vi.fn() };
    const useCase = new RemoverFeriadoUseCase(repo, tenantContext(), { recordAll } as never);
    await expect(useCase.execute('h-inexistente')).rejects.toThrow(NotFoundException);
    expect(recordAll).not.toHaveBeenCalled();
  });
});

describe('ListarFeriadosUseCase', () => {
  it('delega ao Repository com o tenantId do contexto', async () => {
    const holiday = fakeHoliday();
    const repo = { findByTenantAndRange: vi.fn().mockResolvedValue([holiday]), save: vi.fn(), findById: vi.fn(), delete: vi.fn() };
    const useCase = new ListarFeriadosUseCase(repo, tenantContext());
    const from = new Date('2026-12-01T00:00:00');
    const to = new Date('2026-12-31T00:00:00');
    const result = await useCase.execute(from, to);
    expect(repo.findByTenantAndRange).toHaveBeenCalledWith(TENANT_ID, from, to);
    expect(result).toEqual([holiday]);
  });
});
