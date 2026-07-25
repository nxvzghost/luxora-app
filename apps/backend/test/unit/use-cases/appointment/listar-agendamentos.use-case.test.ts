import { describe, it, expect, vi } from 'vitest';
import { ListarAgendamentosUseCase } from '@use-cases/appointment/listar-agendamentos.use-case';

describe('ListarAgendamentosUseCase', () => {
  it('delega ao Repository.findByTenantAndRange com o intervalo fornecido', async () => {
    const repo = {
      findById: vi.fn(),
      findActiveByTherapistAndRange: vi.fn(),
      findByTenantAndRange: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      saveMany: vi.fn(),
    };
    const useCase = new ListarAgendamentosUseCase(repo);
    const from = new Date('2026-08-01');
    const to = new Date('2026-08-07');
    await useCase.execute(from, to);
    expect(repo.findByTenantAndRange).toHaveBeenCalledWith(from, to);
  });
});
