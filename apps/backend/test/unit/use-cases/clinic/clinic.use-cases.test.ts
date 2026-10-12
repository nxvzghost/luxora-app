import { describe, it, expect, vi } from 'vitest';
import {
  ConsultarClinicaUseCase,
  AtualizarClinicaUseCase,
  AtualizarPoliticasClinicaUseCase,
  AtualizarDadosPagamentoUseCase,
  AlterarFusoClinicaUseCase,
} from '@use-cases/clinic/clinic.use-cases';
import { Clinic } from '@domain/clinic/clinic.entity';
import { ClinicRepository } from '@domain-services/platform/clinic.repository';
import { ClinicNotFoundError } from '@domain-services/platform/clinic-not-found.error';
import { UnitOfWork } from '@domain-services/platform/unit-of-work';
import { TenantContext } from '@shared/tenant-context';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function fakeClinic() {
  return Clinic.reconstitute({
    tenantId: TENANT_ID,
    name: 'Clínica Teste',
    defaultBillingPolicy: 'per_session',
    defaultSessionDurationMinutes: 50,
    timeZone: 'America/Sao_Paulo',
  });
}

function repoWith(clinic: Clinic | null): ClinicRepository {
  return {
    findByTenantId: vi.fn().mockResolvedValue(clinic),
    save: vi.fn().mockResolvedValue(undefined),
    findByTenantIdForUpdate: vi.fn().mockResolvedValue(clinic),
    saveTimeZone: vi.fn().mockResolvedValue(undefined),
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

describe('AlterarFusoClinicaUseCase — AD-039 (ADR-0064)', () => {
  /** Registra a ordem do que aconteceu, e se foi dentro da unidade de trabalho. */
  function setup(clinic: Clinic | null = fakeClinic()) {
    const steps: string[] = [];
    let inside = false;
    const mark = (step: string) => {
      steps.push(`${step}:${inside ? 'dentro' : 'fora'}`);
    };
    const repo: ClinicRepository = {
      findByTenantId: vi.fn(async () => clinic),
      save: vi.fn(async () => undefined),
      findByTenantIdForUpdate: vi.fn(async () => {
        mark('ler com trava');
        return clinic;
      }),
      saveTimeZone: vi.fn(async () => mark('gravar o fuso')),
    };
    const audit = { recordAll: vi.fn(async (_events: unknown[]) => mark('auditar')) };
    let units = 0;
    const unitOfWork: UnitOfWork = {
      async run<T>(work: () => Promise<T>): Promise<T> {
        units += 1;
        inside = true;
        try {
          return await work();
        } finally {
          inside = false;
        }
      },
    };
    const useCase = new AlterarFusoClinicaUseCase(repo, tenantContext(), audit as never, unitOfWork);
    return { useCase, repo, audit, steps, unitsOfWork: () => units };
  }

  it('lê, grava e audita dentro da mesma unidade de trabalho, nessa ordem', async () => {
    const { useCase, repo, audit, steps, unitsOfWork } = setup();

    const clinic = await useCase.execute({ timeZone: 'America/Manaus' });

    expect(clinic.timeZone).toBe('America/Manaus');
    expect(unitsOfWork()).toBe(1);
    expect(steps).toEqual(['ler com trava:dentro', 'gravar o fuso:dentro', 'auditar:dentro']);
    expect(repo.findByTenantIdForUpdate).toHaveBeenCalledWith(TENANT_ID);
    expect(vi.mocked(repo.saveTimeZone).mock.calls[0][0].timeZone).toBe('America/Manaus');
    // A gravação geral da clínica não participa: ela não grava o fuso.
    expect(repo.save).not.toHaveBeenCalled();
    expect(audit.recordAll.mock.calls[0][0]).toEqual([
      expect.objectContaining({ eventName: 'ClinicaAtualizada', action: 'fuso_alterado', fromTimeZone: 'America/Sao_Paulo', toTimeZone: 'America/Manaus' }),
    ]);
  });

  it('o fuso que a clínica já tem: não grava e não audita', async () => {
    const { useCase, repo, audit } = setup();

    const clinic = await useCase.execute({ timeZone: 'America/Sao_Paulo' });

    expect(clinic.timeZone).toBe('America/Sao_Paulo');
    expect(repo.saveTimeZone).not.toHaveBeenCalled();
    expect(audit.recordAll).not.toHaveBeenCalled();
  });

  it('fuso inválido: lança, não grava e não audita', async () => {
    const { useCase, repo, audit } = setup();

    await expect(useCase.execute({ timeZone: 'Brasilia' })).rejects.toThrow(/Fuso horário inválido: "Brasilia"/);

    expect(repo.saveTimeZone).not.toHaveBeenCalled();
    expect(audit.recordAll).not.toHaveBeenCalled();
  });

  it('se a auditoria falha, o erro atravessa a unidade de trabalho — é ela que desfaz a gravação', async () => {
    const { useCase, audit, steps } = setup();
    audit.recordAll.mockRejectedValueOnce(new Error('auditoria fora do ar'));

    await expect(useCase.execute({ timeZone: 'America/Manaus' })).rejects.toThrow('auditoria fora do ar');
    expect(steps).toEqual(['ler com trava:dentro', 'gravar o fuso:dentro']);
  });

  it('clínica sem configuração: ClinicNotFoundError, sem gravar', async () => {
    const { useCase, repo } = setup(null);

    await expect(useCase.execute({ timeZone: 'America/Manaus' })).rejects.toThrow(ClinicNotFoundError);
    expect(repo.saveTimeZone).not.toHaveBeenCalled();
  });
});
