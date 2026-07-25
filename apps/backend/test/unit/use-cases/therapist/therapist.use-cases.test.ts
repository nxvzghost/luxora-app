import { describe, it, expect, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  CadastrarTerapeutaUseCase,
  ConsultarTerapeutaUseCase,
  ListarTerapeutasUseCase,
  AtualizarTerapeutaUseCase,
} from '@use-cases/therapist/therapist.use-cases';
import { Therapist } from '@domain/therapist/therapist.entity';
import { TherapistRepository } from '@domain-services/platform/therapist.repository';
import { ClinicSubscription, PlanTier } from '@domain/subscription/clinic-subscription.entity';
import { ClinicSubscriptionRepository } from '@domain-services/subscription/clinic-subscription.repository';
import { TenantContext } from '@shared/tenant-context';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function fakeTherapist(id = 't1') {
  return Therapist.create({ id, tenantId: TENANT_ID, name: 'Dra. Ana' });
}

function repoWith(therapists: Therapist[]): TherapistRepository {
  return {
    findById: vi.fn().mockResolvedValue(therapists[0] ?? null),
    findAllByTenant: vi.fn().mockResolvedValue(therapists),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function subscriptionRepoWith(plan: PlanTier | null): ClinicSubscriptionRepository {
  const subscription = plan
    ? ClinicSubscription.reconstitute({ id: 's1', tenantId: TENANT_ID, plan, billingCycle: 'monthly', status: 'Active' })
    : null;
  return {
    findByTenantId: vi.fn().mockResolvedValue(subscription),
    findByAsaasSubscriptionId: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function newTenantContext() {
  const tenantContext = new TenantContext();
  tenantContext.set(TENANT_ID, 'user-1');
  return tenantContext;
}

describe('CadastrarTerapeutaUseCase', () => {
  it('cria o terapeuta com o tenantId do contexto', async () => {
    const repo = repoWith([]);
    const useCase = new CadastrarTerapeutaUseCase(repo, subscriptionRepoWith('business'), newTenantContext());
    const therapist = await useCase.execute({ name: 'Dra. Ana' });
    expect(therapist.tenantId).toBe(TENANT_ID);
    expect(repo.save).toHaveBeenCalledOnce();
  });

  // Professional e Business são ambos uso individual (1 terapeuta) — regra
  // de negócio confirmada em PD-002: diferem entre si só pelas outras
  // linhas da tabela (BI, API, suporte), nunca pela quantidade de
  // terapeutas. Por isso os dois têm exatamente o mesmo comportamento aqui.
  it.each(['professional', 'business'] as const)('%s com 0 terapeutas consegue cadastrar o 1º', async (plan) => {
    const repo = repoWith([]);
    const useCase = new CadastrarTerapeutaUseCase(repo, subscriptionRepoWith(plan), newTenantContext());
    await expect(useCase.execute({ name: 'Dra. Ana' })).resolves.toBeInstanceOf(Therapist);
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it.each(['professional', 'business'] as const)(
    '%s com 1 terapeuta é bloqueado no 2º, com THERAPIST_LIMIT_REACHED',
    async (plan) => {
      const repo = repoWith([fakeTherapist()]);
      const useCase = new CadastrarTerapeutaUseCase(repo, subscriptionRepoWith(plan), newTenantContext());

      await expect(useCase.execute({ name: 'Dr. Bruno' })).rejects.toThrow(ConflictException);
      expect(repo.save).not.toHaveBeenCalled();

      try {
        await useCase.execute({ name: 'Dr. Bruno' });
      } catch (err) {
        expect((err as ConflictException).getResponse()).toMatchObject({
          code: 'THERAPIST_LIMIT_REACHED',
          category: 'business_rule',
        });
      }
    },
  );

  it('Enterprise com 4 terapeutas ainda consegue cadastrar o 5º (dentro do teto)', async () => {
    const repo = repoWith(['t1', 't2', 't3', 't4'].map((id) => fakeTherapist(id)));
    const useCase = new CadastrarTerapeutaUseCase(repo, subscriptionRepoWith('enterprise'), newTenantContext());
    await expect(useCase.execute({ name: 'Dr. Carlos' })).resolves.toBeInstanceOf(Therapist);
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it('Enterprise com 5 terapeutas (teto atual) é bloqueado no 6º, com THERAPIST_LIMIT_REACHED', async () => {
    const repo = repoWith(['t1', 't2', 't3', 't4', 't5'].map((id) => fakeTherapist(id)));
    const useCase = new CadastrarTerapeutaUseCase(repo, subscriptionRepoWith('enterprise'), newTenantContext());

    await expect(useCase.execute({ name: 'Dr. Carlos' })).rejects.toThrow(ConflictException);
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe('ConsultarTerapeutaUseCase', () => {
  it('retorna o terapeuta quando encontrado', async () => {
    const repo = repoWith([fakeTherapist()]);
    const useCase = new ConsultarTerapeutaUseCase(repo);
    const therapist = await useCase.execute('t1');
    expect(therapist.name).toBe('Dra. Ana');
  });

  it('lança NotFoundException quando não encontrado', async () => {
    const repo = repoWith([]);
    const useCase = new ConsultarTerapeutaUseCase(repo);
    await expect(useCase.execute('t-inexistente')).rejects.toThrow(NotFoundException);
  });
});

describe('ListarTerapeutasUseCase', () => {
  it('delega ao Repository', async () => {
    const repo = repoWith([fakeTherapist()]);
    const useCase = new ListarTerapeutasUseCase(repo);
    const result = await useCase.execute();
    expect(result).toHaveLength(1);
  });
});

describe('AtualizarTerapeutaUseCase', () => {
  it('atualiza o nome via método explícito da entidade', async () => {
    const repo = repoWith([fakeTherapist()]);
    const useCase = new AtualizarTerapeutaUseCase(repo, new ConsultarTerapeutaUseCase(repo), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const therapist = await useCase.execute({ id: 't1', name: 'Dra. Ana Silva' });
    expect(therapist.name).toBe('Dra. Ana Silva');
  });

  it('não altera o nome quando não fornecido', async () => {
    const repo = repoWith([fakeTherapist()]);
    const useCase = new AtualizarTerapeutaUseCase(repo, new ConsultarTerapeutaUseCase(repo), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const therapist = await useCase.execute({ id: 't1' });
    expect(therapist.name).toBe('Dra. Ana');
  });
});
