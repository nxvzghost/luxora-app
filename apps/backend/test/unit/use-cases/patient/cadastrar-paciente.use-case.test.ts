import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { CadastrarPacienteUseCase } from '@use-cases/patient/cadastrar-paciente.use-case';
import { TenantContext } from '@shared/tenant-context';
import { PatientRepository } from '@domain-services/patient-ops/patient.repository';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

describe('CadastrarPacienteUseCase', () => {
  let repoMock: PatientRepository;
  let tenantContext: TenantContext;
  let useCase: CadastrarPacienteUseCase;

  beforeEach(() => {
    repoMock = {
      findById: vi.fn(),
      findAllByTenant: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    tenantContext = new TenantContext();
    tenantContext.set(TENANT_ID, 'user-1');
    const auditServiceMock = { recordAll: vi.fn().mockResolvedValue(undefined) };
    useCase = new CadastrarPacienteUseCase(repoMock, auditServiceMock as never, tenantContext);
  });

  it('rejeita nome vazio', async () => {
    await expect(useCase.execute({ name: '   ', phone: '+5541900000000' })).rejects.toThrow(
      ConflictException,
    );
  });

  it('cria o paciente já no estado Cadastrado (percorrendo Novo → Identificado → Cadastrado)', async () => {
    const patient = await useCase.execute({ name: 'Maria', phone: '+5541900000000' });
    expect(patient.state).toBe('Cadastrado');
    expect(patient.name).toBe('Maria');
    expect(patient.tenantId).toBe(TENANT_ID);
  });

  it('remove espaços em branco do nome', async () => {
    const patient = await useCase.execute({ name: '  Maria  ', phone: '+5541900000000' });
    expect(patient.name).toBe('Maria');
  });

  it('persiste o paciente via Repository.save', async () => {
    await useCase.execute({ name: 'Maria', phone: '+5541900000000' });
    expect(repoMock.save).toHaveBeenCalledOnce();
  });

  it('esvazia a fila de eventos de domínio após a criação (não acumula em memória)', async () => {
    const patient = await useCase.execute({ name: 'Maria', phone: '+5541900000000' });
    expect(patient.pullDomainEvents()).toHaveLength(0);
  });
});
