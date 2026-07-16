import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AtualizarPacienteUseCase } from '@use-cases/patient/atualizar-paciente.use-case';
import { ConsultarPacienteUseCase } from '@use-cases/patient/consultar-paciente.use-case';
import { Patient } from '@domain/patient/patient.entity';
import { PatientRepository } from '@domain-services/patient-ops/patient.repository';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function fakePatient(overrides: Partial<{ billingPolicyOverride: 'weekly' | 'monthly' | 'per_session' }> = {}) {
  return Patient.reconstitute({
    id: 'p1',
    tenantId: TENANT_ID,
    name: 'Maria',
    phone: '+5541900000000',
    state: 'Ativo',
    ...overrides,
  });
}

describe('AtualizarPacienteUseCase', () => {
  let repoMock: PatientRepository;
  let consultarPaciente: ConsultarPacienteUseCase;
  let useCase: AtualizarPacienteUseCase;

  beforeEach(() => {
    repoMock = {
      findById: vi.fn().mockResolvedValue(fakePatient()),
      findAllByTenant: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    consultarPaciente = new ConsultarPacienteUseCase(repoMock);
    useCase = new AtualizarPacienteUseCase(repoMock, consultarPaciente, { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
  });

  it('atualiza o nome quando fornecido', async () => {
    const updated = await useCase.execute({ id: 'p1', name: 'Maria Silva' });
    expect(updated.name).toBe('Maria Silva');
  });

  it('mantém o nome original quando não fornecido', async () => {
    const updated = await useCase.execute({ id: 'p1' });
    expect(updated.name).toBe('Maria');
  });

  it('define billingPolicyOverride quando fornecido', async () => {
    const updated = await useCase.execute({ id: 'p1', billingPolicyOverride: 'monthly' });
    expect(updated.billingPolicyOverride).toBe('monthly');
  });

  it('remove billingPolicyOverride quando explicitamente null (volta a herdar o padrão da clínica)', async () => {
    vi.mocked(repoMock.findById).mockResolvedValue(fakePatient({ billingPolicyOverride: 'weekly' }));
    const updated = await useCase.execute({ id: 'p1', billingPolicyOverride: null });
    expect(updated.billingPolicyOverride).toBeUndefined();
  });

  it('preserva o estado do paciente (Atualizar nunca muda o estado)', async () => {
    const updated = await useCase.execute({ id: 'p1', name: 'Maria Silva' });
    expect(updated.state).toBe('Ativo');
  });

  it('persiste a versão atualizada via Repository.save', async () => {
    await useCase.execute({ id: 'p1', name: 'Maria Silva' });
    expect(repoMock.save).toHaveBeenCalledOnce();
  });
});
