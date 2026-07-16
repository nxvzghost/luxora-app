import { describe, it, expect, vi } from 'vitest';
import {
  ConsultarClinicaUseCase,
  AtualizarClinicaUseCase,
  AtualizarPoliticasClinicaUseCase,
  AtualizarDadosPagamentoUseCase,
} from '@use-cases/clinic/clinic.use-cases';
import { Clinic } from '@domain/clinic/clinic.entity';
import { ClinicRepository } from '@domain-services/platform/clinic.repository';
import { ClinicNotFoundError } from '@domain-services/platform/clinic-not-found.error';
import { TenantContext } from '@shared/tenant-context';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function fakeClinic() {
  return Clinic.reconstitute({
    tenantId: TENANT_ID,
    name: 'Clínica Teste',
    defaultBillingPolicy: 'per_session',
    defaultSessionDurationMinutes: 50,
  });
}

function repoWith(clinic: Clinic | null): ClinicRepository {
  return {
    findByTenantId: vi.fn().mockResolvedValue(clinic),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function tenantContext() {
  const tc = new TenantContext();
  tc.set(TENANT_ID, 'user-1');
  return tc;
}

describe('ConsultarClinicaUseCase', () => {
  it('retorna a clínica do Tenant do contexto', async () => {
    const repo = repoWith(fakeClinic());
    const useCase = new ConsultarClinicaUseCase(repo, tenantContext());
    const clinic = await useCase.execute();
    expect(clinic.name).toBe('Clínica Teste');
  });

  it('lança ClinicNotFoundError quando Tenant/ClinicSettings não existem', async () => {
    const repo = repoWith(null);
    const useCase = new ConsultarClinicaUseCase(repo, tenantContext());
    await expect(useCase.execute()).rejects.toThrow(ClinicNotFoundError);
  });
});

describe('AtualizarClinicaUseCase', () => {
  it('atualiza o nome', async () => {
    const repo = repoWith(fakeClinic());
    const useCase = new AtualizarClinicaUseCase(repo, new ConsultarClinicaUseCase(repo, tenantContext()), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const clinic = await useCase.execute({ name: 'Novo Nome' });
    expect(clinic.name).toBe('Novo Nome');
  });
});

describe('AtualizarPoliticasClinicaUseCase', () => {
  it('atualiza a política de cobrança padrão', async () => {
    const repo = repoWith(fakeClinic());
    const useCase = new AtualizarPoliticasClinicaUseCase(repo, new ConsultarClinicaUseCase(repo, tenantContext()), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const clinic = await useCase.execute({ defaultBillingPolicy: 'monthly' });
    expect(clinic.defaultBillingPolicy).toBe('monthly');
  });

  it('atualiza defaultSessionDurationMinutes', async () => {
    const repo = repoWith(fakeClinic());
    const useCase = new AtualizarPoliticasClinicaUseCase(repo, new ConsultarClinicaUseCase(repo, tenantContext()), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const clinic = await useCase.execute({ defaultSessionDurationMinutes: 45 });
    expect(clinic.defaultSessionDurationMinutes).toBe(45);
  });

  it('propaga erro de validação da entidade (ex: cancellationHoursLimit negativo)', async () => {
    const repo = repoWith(fakeClinic());
    const useCase = new AtualizarPoliticasClinicaUseCase(repo, new ConsultarClinicaUseCase(repo, tenantContext()), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    await expect(useCase.execute({ cancellationHoursLimit: -5 })).rejects.toThrow(/não pode ser negativo/);
  });
});

describe('AtualizarDadosPagamentoUseCase', () => {
  it('atualiza pixKey e payeeName', async () => {
    const repo = repoWith(fakeClinic());
    const useCase = new AtualizarDadosPagamentoUseCase(repo, new ConsultarClinicaUseCase(repo, tenantContext()), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const clinic = await useCase.execute({ pixKey: '41999999999', payeeName: 'Clínica Teste LTDA' });
    expect(clinic.pixKey).toBe('41999999999');
    expect(clinic.payeeName).toBe('Clínica Teste LTDA');
  });
});
