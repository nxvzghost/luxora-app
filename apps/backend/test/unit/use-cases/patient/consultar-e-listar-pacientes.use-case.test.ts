import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ConsultarPacienteUseCase } from '@use-cases/patient/consultar-paciente.use-case';
import { ListarPacientesUseCase } from '@use-cases/patient/listar-pacientes.use-case';
import { Patient } from '@domain/patient/patient.entity';
import { PatientRepository } from '@domain-services/patient-ops/patient.repository';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function fakePatient() {
  return Patient.reconstitute({
    id: 'p1',
    tenantId: TENANT_ID,
    name: 'Maria',
    phone: '+5541900000000',
    state: 'Ativo',
  });
}

describe('ConsultarPacienteUseCase', () => {
  let repoMock: PatientRepository;
  let useCase: ConsultarPacienteUseCase;

  beforeEach(() => {
    repoMock = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn() };
    useCase = new ConsultarPacienteUseCase(repoMock);
  });

  it('retorna o paciente quando encontrado', async () => {
    vi.mocked(repoMock.findById).mockResolvedValue(fakePatient());
    const patient = await useCase.execute('p1');
    expect(patient.name).toBe('Maria');
  });

  it('lança NotFoundException quando o paciente não existe (ou está em outro Tenant)', async () => {
    vi.mocked(repoMock.findById).mockResolvedValue(null);
    await expect(useCase.execute('p-inexistente')).rejects.toThrow(NotFoundException);
  });
});

describe('ListarPacientesUseCase', () => {
  it('delega diretamente ao Repository.findAllByTenant, repassando cursor e limit', async () => {
    const repoMock: PatientRepository = {
      findById: vi.fn(),
      findAllByTenant: vi.fn().mockResolvedValue([fakePatient()]),
      save: vi.fn(),
    };
    const useCase = new ListarPacientesUseCase(repoMock);
    const result = await useCase.execute({ cursor: 'abc', limit: 10 });
    expect(repoMock.findAllByTenant).toHaveBeenCalledWith({ cursor: 'abc', limit: 10 });
    expect(result).toHaveLength(1);
  });
});
