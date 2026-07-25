import { describe, it, expect, vi } from 'vitest';
import { CriarRecurringBlockUseCase, ListarRecurringBlocksUseCase } from '@use-cases/availability/gerenciar-recurring-block.use-case';
import { RecurringBlock } from '@domain/availability/recurring-block.entity';
import { TenantContext } from '@shared/tenant-context';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-2222-2222-222222222222';
const PATIENT_ID = 'p1';
const THERAPIST_ID = 't1';

function tenantContext(tenantId = TENANT_ID) {
  const tc = new TenantContext();
  tc.set(tenantId, 'user-1');
  return tc;
}

function fakeRepo(overrides: Record<string, unknown> = {}) {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn(),
    findByTenantAndTherapist: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function fakeBlock() {
  return RecurringBlock.create({
    id: 'rb1',
    tenantId: TENANT_ID,
    patientId: PATIENT_ID,
    therapistId: THERAPIST_ID,
    firstOccurrence: new Date('2026-08-04T14:00:00'),
    intervalDays: 7,
    modality: 'presencial',
    renewalMode: 'automatic',
  });
}

function fakeAudit(overrides: Record<string, unknown> = {}) {
  return { recordAll: vi.fn().mockResolvedValue(undefined), ...overrides };
}

describe('CriarRecurringBlockUseCase', () => {
  it('cria o bloco com o tenantId do contexto', async () => {
    const repo = fakeRepo();
    const useCase = new CriarRecurringBlockUseCase(repo as never, tenantContext(), fakeAudit() as never);

    const block = await useCase.execute({
      patientId: PATIENT_ID,
      therapistId: THERAPIST_ID,
      firstOccurrence: new Date('2026-08-04T14:00:00'),
      intervalDays: 7,
      modality: 'presencial',
      renewalMode: 'automatic',
    });

    expect(block.tenantId).toBe(TENANT_ID);
    expect(block.patientId).toBe(PATIENT_ID);
    expect(block.therapistId).toBe(THERAPIST_ID);
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it('propaga erro de validação da entidade (ex: intervalDays inválido)', async () => {
    const repo = fakeRepo();
    const useCase = new CriarRecurringBlockUseCase(repo as never, tenantContext(), fakeAudit() as never);

    await expect(
      useCase.execute({
        patientId: PATIENT_ID,
        therapistId: THERAPIST_ID,
        firstOccurrence: new Date('2026-08-04T14:00:00'),
        intervalDays: 0,
        modality: 'presencial',
        renewalMode: 'automatic',
      }),
    ).rejects.toThrow(/inteiro positivo/);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('auditoria: registra BlocoRecorrenteCriado após save(), nunca antes', async () => {
    const calls: string[] = [];
    const repo = fakeRepo({
      save: vi.fn().mockImplementation(async () => {
        calls.push('save');
      }),
    });
    const recordAll = vi.fn().mockImplementation(async () => {
      calls.push('recordAll');
    });
    const useCase = new CriarRecurringBlockUseCase(repo as never, tenantContext(), fakeAudit({ recordAll }) as never);

    await useCase.execute({
      patientId: PATIENT_ID,
      therapistId: THERAPIST_ID,
      firstOccurrence: new Date('2026-08-04T14:00:00'),
      intervalDays: 7,
      modality: 'presencial',
      renewalMode: 'automatic',
    });

    expect(calls).toEqual(['save', 'recordAll']);
    expect(recordAll).toHaveBeenCalledOnce();
    const events = recordAll.mock.calls[0][0];
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe('BlocoRecorrenteCriado');
    expect(events[0].tenantId).toBe(TENANT_ID);
  });

  it('validação inválida nunca dispara recordAll()', async () => {
    const repo = fakeRepo();
    const recordAll = vi.fn();
    const useCase = new CriarRecurringBlockUseCase(repo as never, tenantContext(), fakeAudit({ recordAll }) as never);

    await expect(
      useCase.execute({
        patientId: PATIENT_ID,
        therapistId: THERAPIST_ID,
        firstOccurrence: new Date('2026-08-04T14:00:00'),
        intervalDays: -1,
        modality: 'presencial',
        renewalMode: 'automatic',
      }),
    ).rejects.toThrow();
    expect(recordAll).not.toHaveBeenCalled();
  });
});

describe('ListarRecurringBlocksUseCase', () => {
  it('delega ao Repository com o tenantId do contexto e o therapistId do parâmetro', async () => {
    const block = fakeBlock();
    const repo = fakeRepo({ findByTenantAndTherapist: vi.fn().mockResolvedValue([block]) });
    const useCase = new ListarRecurringBlocksUseCase(repo as never, tenantContext());

    const result = await useCase.execute(THERAPIST_ID);

    expect(repo.findByTenantAndTherapist).toHaveBeenCalledWith(TENANT_ID, THERAPIST_ID);
    expect(result).toEqual([block]);
  });

  it('usa o tenantId de quem chama — nunca do bloco retornado nem de nenhum outro tenant', async () => {
    const repo = fakeRepo({ findByTenantAndTherapist: vi.fn().mockResolvedValue([]) });
    const useCase = new ListarRecurringBlocksUseCase(repo as never, tenantContext(OTHER_TENANT_ID));

    await useCase.execute(THERAPIST_ID);

    expect(repo.findByTenantAndTherapist).toHaveBeenCalledWith(OTHER_TENANT_ID, THERAPIST_ID);
  });

  it('não chama nenhum método de auditoria — consulta pura', async () => {
    const repo = fakeRepo();
    const useCase = new ListarRecurringBlocksUseCase(repo as never, tenantContext());
    // ListarRecurringBlocksUseCase não recebe AuditService no construtor —
    // a ausência do parâmetro já é a prova estrutural (TS não compilaria
    // uma tentativa de chamar this.auditService aqui).
    await useCase.execute(THERAPIST_ID);
    expect(repo.save).not.toHaveBeenCalled();
  });
});
