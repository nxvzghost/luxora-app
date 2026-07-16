import { describe, it, expect, vi } from 'vitest';
import { ReenviarAgendaAtualizadaUseCase } from '@use-cases/scheduling/reenviar-agenda-atualizada.use-case';
import { Therapist } from '@domain/therapist/therapist.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

describe('ReenviarAgendaAtualizadaUseCase', () => {
  it('enfileira com idempotencyKey diferente do resumo original (cada reenvio é mensagem nova)', async () => {
    const therapist = Therapist.create({ id: 't1', tenantId: TENANT_ID, name: 'Dra. Ana' });
    const appointmentRepo = { findById: vi.fn(), findActiveByTherapistAndRange: vi.fn().mockResolvedValue([]), findByTenantAndRange: vi.fn(), save: vi.fn() };
    const therapistRepo = { findById: vi.fn().mockResolvedValue(therapist), findAllByTenant: vi.fn(), save: vi.fn() };
    const messageQueue = { enqueue: vi.fn().mockResolvedValue(undefined) };

    const useCase = new ReenviarAgendaAtualizadaUseCase(appointmentRepo, therapistRepo, messageQueue);
    await useCase.execute(TENANT_ID, 't1', '+5541900000000');

    const call = messageQueue.enqueue.mock.calls[0][0];
    expect(call.idempotencyKey).toContain('agenda-summary-updated-t1-');
    expect(call.body).toContain('foi atualizada');
  });
});
