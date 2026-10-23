import { describe, it, expect, vi } from 'vitest';
import { ListarAgendamentosUseCase } from '@use-cases/appointment/listar-agendamentos.use-case';
import { Appointment } from '@domain/appointment/appointment.entity';
import { AppointmentOutcomeRecord } from '@domain/appointment/appointment-outcome';

function appointment(id: string) {
  return Appointment.reconstitute({
    id,
    tenantId: '11111111-1111-1111-1111-111111111111',
    patientId: 'p1',
    therapistId: 't1',
    scheduledAt: new Date('2026-08-03T09:00:00Z'),
    modality: 'presencial',
    state: 'Confirmada',
    recurring: false,
  });
}

describe('ListarAgendamentosUseCase', () => {
  it('delega ao Repository.findByTenantAndRange com o intervalo fornecido', async () => {
    const repo = {
      findById: vi.fn(),
      findByIdForUpdate: vi.fn(),
      findSuccessorId: vi.fn(),
      findActiveByTherapistAndRange: vi.fn(),
      findByTenantAndRange: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      saveMany: vi.fn(),
      existsForRecurringBlockOccurrence: vi.fn(),
    };
    const outcomes = { findByAppointmentIds: vi.fn().mockResolvedValue(new Map()) };
    const useCase = new ListarAgendamentosUseCase(repo, outcomes as never);
    const from = new Date('2026-08-01');
    const to = new Date('2026-08-07');
    await useCase.execute(from, to);
    expect(repo.findByTenantAndRange).toHaveBeenCalledWith(from, to);
  });

  it('K2-b — cada consulta vem com o desfecho registrado, ou null', async () => {
    const withOutcome = appointment('a1');
    const without = appointment('a2');
    const outcome = AppointmentOutcomeRecord.recordNoShow(withOutcome, { userId: 'u1', now: new Date('2026-08-03T11:00:00Z') });
    const repo = { findByTenantAndRange: vi.fn().mockResolvedValue([withOutcome, without]) };
    const outcomes = { findByAppointmentIds: vi.fn().mockResolvedValue(new Map([['a1', outcome]])) };
    const rows = await new ListarAgendamentosUseCase(repo as never, outcomes as never).execute(new Date(0), new Date());
    expect(outcomes.findByAppointmentIds).toHaveBeenCalledWith(['a1', 'a2']);
    expect(rows.map((row) => [row.appointment.id, row.outcome?.outcome ?? null])).toEqual([
      ['a1', 'Falta'],
      ['a2', null],
    ]);
  });
});
