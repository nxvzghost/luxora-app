import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import {
  CadastrarTerapeutaUseCase,
  ConsultarTerapeutaUseCase,
  ListarTerapeutasUseCase,
  AtualizarTerapeutaUseCase,
  DefinirDisponibilidadeUseCase,
} from '@use-cases/therapist/therapist.use-cases';
import { Therapist } from '@domain/therapist/therapist.entity';
import { TherapistRepository } from '@domain-services/platform/therapist.repository';
import { TenantContext } from '@shared/tenant-context';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function fakeTherapist() {
  return Therapist.create({ id: 't1', tenantId: TENANT_ID, name: 'Dra. Ana' });
}

function repoWith(therapist: Therapist | null): TherapistRepository {
  return {
    findById: vi.fn().mockResolvedValue(therapist),
    findAllByTenant: vi.fn().mockResolvedValue(therapist ? [therapist] : []),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

describe('CadastrarTerapeutaUseCase', () => {
  it('cria o terapeuta com o tenantId do contexto', async () => {
    const repo = repoWith(null);
    const tenantContext = new TenantContext();
    tenantContext.set(TENANT_ID, 'user-1');
    const useCase = new CadastrarTerapeutaUseCase(repo, tenantContext);
    const therapist = await useCase.execute({ name: 'Dra. Ana' });
    expect(therapist.tenantId).toBe(TENANT_ID);
    expect(repo.save).toHaveBeenCalledOnce();
  });
});

describe('ConsultarTerapeutaUseCase', () => {
  it('retorna o terapeuta quando encontrado', async () => {
    const repo = repoWith(fakeTherapist());
    const useCase = new ConsultarTerapeutaUseCase(repo);
    const therapist = await useCase.execute('t1');
    expect(therapist.name).toBe('Dra. Ana');
  });

  it('lança NotFoundException quando não encontrado', async () => {
    const repo = repoWith(null);
    const useCase = new ConsultarTerapeutaUseCase(repo);
    await expect(useCase.execute('t-inexistente')).rejects.toThrow(NotFoundException);
  });
});

describe('ListarTerapeutasUseCase', () => {
  it('delega ao Repository', async () => {
    const repo = repoWith(fakeTherapist());
    const useCase = new ListarTerapeutasUseCase(repo);
    const result = await useCase.execute();
    expect(result).toHaveLength(1);
  });
});

describe('AtualizarTerapeutaUseCase', () => {
  it('atualiza o nome via método explícito da entidade', async () => {
    const repo = repoWith(fakeTherapist());
    const useCase = new AtualizarTerapeutaUseCase(repo, new ConsultarTerapeutaUseCase(repo), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const therapist = await useCase.execute({ id: 't1', name: 'Dra. Ana Silva' });
    expect(therapist.name).toBe('Dra. Ana Silva');
  });

  it('não altera o nome quando não fornecido', async () => {
    const repo = repoWith(fakeTherapist());
    const useCase = new AtualizarTerapeutaUseCase(repo, new ConsultarTerapeutaUseCase(repo), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const therapist = await useCase.execute({ id: 't1' });
    expect(therapist.name).toBe('Dra. Ana');
  });
});

describe('DefinirDisponibilidadeUseCase', () => {
  it('define a disponibilidade via método da entidade (com validação já embutida)', async () => {
    const repo = repoWith(fakeTherapist());
    const useCase = new DefinirDisponibilidadeUseCase(repo, new ConsultarTerapeutaUseCase(repo), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const therapist = await useCase.execute('t1', [{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }]);
    expect(therapist.availability).toHaveLength(1);
  });

  it('propaga erro de validação da entidade (ex: sobreposição)', async () => {
    const repo = repoWith(fakeTherapist());
    const useCase = new DefinirDisponibilidadeUseCase(repo, new ConsultarTerapeutaUseCase(repo), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    await expect(
      useCase.execute('t1', [
        { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
        { dayOfWeek: 1, startTime: '11:00', endTime: '14:00' },
      ]),
    ).rejects.toThrow(/sobreposta/);
  });
});
