import { describe, it, expect, vi } from 'vitest';
import {
  InativarPacienteUseCase,
  ReativarPacienteUseCase,
  DarAltaPacienteUseCase,
} from '@use-cases/patient/gerenciar-status-paciente.use-case';
import { ConsultarPacienteUseCase } from '@use-cases/patient/consultar-paciente.use-case';
import { Patient, PatientState } from '@domain/patient/patient.entity';
import { PatientRepository } from '@domain-services/patient-ops/patient.repository';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function fakePatient(state: PatientState) {
  return Patient.reconstitute({
    id: 'p1',
    tenantId: TENANT_ID,
    name: 'Maria',
    phone: '+5541900000000',
    state,
  });
}

function repoWithPatient(state: PatientState): PatientRepository {
  return {
    findById: vi.fn().mockResolvedValue(fakePatient(state)),
    findAllByTenant: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

describe('InativarPacienteUseCase', () => {
  it('transiciona de Ativo para Inativo', async () => {
    const repo = repoWithPatient('Ativo');
    const useCase = new InativarPacienteUseCase(repo, new ConsultarPacienteUseCase(repo), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const patient = await useCase.execute('p1');
    expect(patient.state).toBe('Inativo');
  });

  it('rejeita inativar a partir de um estado que não permite (ex: Novo)', async () => {
    const repo = repoWithPatient('Novo');
    const useCase = new InativarPacienteUseCase(repo, new ConsultarPacienteUseCase(repo), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    await expect(useCase.execute('p1')).rejects.toThrow();
  });
});

describe('ReativarPacienteUseCase', () => {
  it('transiciona de Inativo para Ativo (JP-013)', async () => {
    const repo = repoWithPatient('Inativo');
    const useCase = new ReativarPacienteUseCase(repo, new ConsultarPacienteUseCase(repo), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const patient = await useCase.execute('p1');
    expect(patient.state).toBe('Ativo');
  });

  it('rejeita reativar a partir de um estado que não é Inativo', async () => {
    const repo = repoWithPatient('Ativo');
    const useCase = new ReativarPacienteUseCase(repo, new ConsultarPacienteUseCase(repo), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    await expect(useCase.execute('p1')).rejects.toThrow();
  });
});

describe('DarAltaPacienteUseCase', () => {
  it('transiciona de Ativo para Alta (JP-014)', async () => {
    const repo = repoWithPatient('Ativo');
    const useCase = new DarAltaPacienteUseCase(repo, new ConsultarPacienteUseCase(repo), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const patient = await useCase.execute('p1');
    expect(patient.state).toBe('Alta');
  });

  it('rejeita dar alta a partir de Alta (estado já terminal)', async () => {
    const repo = repoWithPatient('Alta');
    const useCase = new DarAltaPacienteUseCase(repo, new ConsultarPacienteUseCase(repo), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    await expect(useCase.execute('p1')).rejects.toThrow();
  });
});
