import { describe, it, expect, vi } from 'vitest';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { MaterializarRecurringBlockUseCase } from '@use-cases/availability/materializar-recurring-block.use-case';
import { RecurringBlock } from '@domain/availability/recurring-block.entity';
import { TenantContext } from '@shared/tenant-context';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const BLOCK_ID = 'rb1';
const PATIENT_ID = 'p1';
const THERAPIST_ID = 't1';

function tenantContext() {
  const tc = new TenantContext();
  tc.set(TENANT_ID, 'user-1');
  return tc;
}

function fakeBlock(overrides: Partial<{ firstOccurrence: Date; intervalDays: number }> = {}) {
  return RecurringBlock.create({
    id: BLOCK_ID,
    tenantId: TENANT_ID,
    patientId: PATIENT_ID,
    therapistId: THERAPIST_ID,
    firstOccurrence: overrides.firstOccurrence ?? new Date('2026-08-04T14:00:00'),
    intervalDays: overrides.intervalDays ?? 7,
    modality: 'presencial',
    renewalMode: 'automatic',
  });
}

function fakeAppointmentRepo(overrides: Record<string, unknown> = {}) {
  return {
    findById: vi.fn(),
    findActiveByTherapistAndRange: vi.fn(),
    findByTenantAndRange: vi.fn(),
    save: vi.fn(),
    saveMany: vi.fn().mockResolvedValue(undefined),
    existsForRecurringBlockOccurrence: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

function buildUseCase(
  overrides: Partial<{
    recurringBlockRepo: Record<string, unknown>;
    appointmentRepo: Record<string, unknown>;
    verificarDisponibilidade: { execute: ReturnType<typeof vi.fn> };
    auditService: { recordAll: ReturnType<typeof vi.fn> };
  }> = {},
) {
  const recurringBlockRepo = overrides.recurringBlockRepo ?? {
    findById: vi.fn().mockResolvedValue(fakeBlock()),
    save: vi.fn(),
  };
  const appointmentRepo = overrides.appointmentRepo ?? fakeAppointmentRepo();
  const verificarDisponibilidade = overrides.verificarDisponibilidade ?? { execute: vi.fn().mockResolvedValue(true) };
  const auditService = overrides.auditService ?? { recordAll: vi.fn().mockResolvedValue(undefined) };

  const useCase = new MaterializarRecurringBlockUseCase(
    recurringBlockRepo as never,
    appointmentRepo as never,
    verificarDisponibilidade as never,
    tenantContext(),
    auditService as never,
  );
  return { useCase, recurringBlockRepo, appointmentRepo, verificarDisponibilidade, auditService };
}

describe('MaterializarRecurringBlockUseCase', () => {
  it('materializa todas as ocorrências candidatas dentro da janela, aprovadas pelo Motor', async () => {
    const { useCase, appointmentRepo, verificarDisponibilidade, auditService } = buildUseCase();

    const result = await useCase.execute({
      recurringBlockId: BLOCK_ID,
      from: new Date('2026-08-01T00:00:00'),
      to: new Date('2026-08-22T00:00:00'), // 08-04, 08-11, 08-18
    });

    expect(result.created).toHaveLength(3);
    expect(result.skipped).toHaveLength(0);
    expect(verificarDisponibilidade.execute).toHaveBeenCalledTimes(3);
    expect(appointmentRepo.saveMany).toHaveBeenCalledOnce();
    expect((appointmentRepo.saveMany as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(3);
    expect(auditService.recordAll).toHaveBeenCalledTimes(3);
  });

  it('lança NotFoundException quando o RecurringBlock não existe — nunca chama saveMany', async () => {
    const { useCase, appointmentRepo } = buildUseCase({
      recurringBlockRepo: { findById: vi.fn().mockResolvedValue(null), save: vi.fn() },
    });

    await expect(
      useCase.execute({ recurringBlockId: 'inexistente', from: new Date('2026-08-01T00:00:00'), to: new Date('2026-08-22T00:00:00') }),
    ).rejects.toThrow(NotFoundException);
    expect(appointmentRepo.saveMany).not.toHaveBeenCalled();
  });

  it('rejeita janela inválida (from >= to) sem sequer carregar o RecurringBlock', async () => {
    const { useCase, recurringBlockRepo } = buildUseCase();

    await expect(
      useCase.execute({ recurringBlockId: BLOCK_ID, from: new Date('2026-08-22T00:00:00'), to: new Date('2026-08-01T00:00:00') }),
    ).rejects.toThrow(/from deve ser anterior a to/);
    expect(recurringBlockRepo.findById).not.toHaveBeenCalled();
  });

  it('sequência obrigatória: idempotência ANTES do Motor — ocorrência já materializada nunca consulta VerificarDisponibilidadeUseCase', async () => {
    const already = new Date('2026-08-11T14:00:00');
    const appointmentRepo = fakeAppointmentRepo({
      existsForRecurringBlockOccurrence: vi.fn().mockImplementation((_id: string, scheduledAt: Date) =>
        Promise.resolve(scheduledAt.toISOString() === already.toISOString()),
      ),
    });
    const { useCase, verificarDisponibilidade } = buildUseCase({ appointmentRepo });

    const result = await useCase.execute({
      recurringBlockId: BLOCK_ID,
      from: new Date('2026-08-01T00:00:00'),
      to: new Date('2026-08-22T00:00:00'), // 08-04, 08-11 (já materializada), 08-18
    });

    expect(result.skipped).toContainEqual({ scheduledAt: already, reason: 'already_materialized' });
    expect(verificarDisponibilidade.execute).toHaveBeenCalledTimes(2); // nunca chamado para 08-11
    expect((appointmentRepo.saveMany as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(2);
  });

  it('Motor recusa uma ocorrência específica — pulada com reason not_available, resto do lote não falha', async () => {
    const recusada = new Date('2026-08-11T14:00:00');
    const verificarDisponibilidade = {
      execute: vi.fn().mockImplementation((input: { scheduledAt: Date }) =>
        Promise.resolve(input.scheduledAt.toISOString() !== recusada.toISOString()),
      ),
    };
    const { useCase, appointmentRepo } = buildUseCase({ verificarDisponibilidade });

    const result = await useCase.execute({
      recurringBlockId: BLOCK_ID,
      from: new Date('2026-08-01T00:00:00'),
      to: new Date('2026-08-22T00:00:00'),
    });

    expect(result.skipped).toContainEqual({ scheduledAt: recusada, reason: 'not_available' });
    expect(result.created).toHaveLength(2);
    expect((appointmentRepo.saveMany as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(2);
  });

  it('corrida de concorrência: revalida o lote, ocorrência já existente vira sucesso idempotente, retry único cria as demais', async () => {
    const raced = new Date('2026-08-04T14:00:00');
    const survives = new Date('2026-08-11T14:00:00');
    const callCounts = new Map<string, number>();
    const existsForRecurringBlockOccurrence = vi.fn().mockImplementation((_id: string, scheduledAt: Date) => {
      const key = scheduledAt.toISOString();
      const count = (callCounts.get(key) ?? 0) + 1;
      callCounts.set(key, count);
      // raced: só passa a existir na revalidação pós-corrida (2ª chamada em diante).
      if (key === raced.toISOString() && count >= 2) return Promise.resolve(true);
      return Promise.resolve(false);
    });
    let saveManyCalls = 0;
    const saveMany = vi.fn().mockImplementation(async () => {
      saveManyCalls += 1;
      if (saveManyCalls === 1) {
        throw new ConflictException({ code: 'SESSION_CONFLICT', message: 'x', category: 'business_rule' });
      }
    });
    const appointmentRepo = fakeAppointmentRepo({ existsForRecurringBlockOccurrence, saveMany });
    const { useCase } = buildUseCase({ appointmentRepo });

    const result = await useCase.execute({
      recurringBlockId: BLOCK_ID,
      from: new Date('2026-08-01T00:00:00'),
      to: new Date('2026-08-15T00:00:00'), // 08-04 (raced), 08-11 (survives)
    });

    expect(saveMany).toHaveBeenCalledTimes(2); // tentativa original + 1 retry, nunca mais
    expect(result.created).toHaveLength(1);
    expect(result.created[0].scheduledAt.toISOString()).toBe(survives.toISOString());
    expect(result.skipped).toContainEqual({ scheduledAt: raced, reason: 'already_materialized' });
  });

  it('corrida de concorrência que persiste após o retry único propaga a exceção — nunca faz um segundo retry', async () => {
    const saveMany = vi.fn().mockRejectedValue(new ConflictException({ code: 'SESSION_CONFLICT', message: 'x', category: 'business_rule' }));
    const appointmentRepo = fakeAppointmentRepo({ saveMany }); // existsForRecurringBlockOccurrence sempre false — não é idempotência, é conflito real
    const { useCase } = buildUseCase({ appointmentRepo });

    await expect(
      useCase.execute({ recurringBlockId: BLOCK_ID, from: new Date('2026-08-01T00:00:00'), to: new Date('2026-08-15T00:00:00') }),
    ).rejects.toThrow(ConflictException);
    expect(saveMany).toHaveBeenCalledTimes(2); // original + 1 retry, nunca um 3º
  });

  it('erro de saveMany que NÃO é SESSION_CONFLICT propaga imediatamente, sem tentar revalidar nem retry', async () => {
    const saveMany = vi.fn().mockRejectedValue(new Error('erro genérico de banco'));
    const existsForRecurringBlockOccurrence = vi.fn().mockResolvedValue(false);
    const appointmentRepo = fakeAppointmentRepo({ saveMany, existsForRecurringBlockOccurrence });
    const { useCase } = buildUseCase({ appointmentRepo });

    await expect(
      useCase.execute({ recurringBlockId: BLOCK_ID, from: new Date('2026-08-01T00:00:00'), to: new Date('2026-08-15T00:00:00') }),
    ).rejects.toThrow('erro genérico de banco');
    expect(saveMany).toHaveBeenCalledOnce();
  });
});
