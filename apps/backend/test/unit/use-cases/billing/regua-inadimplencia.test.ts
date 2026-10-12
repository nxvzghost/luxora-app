import { describe, it, expect, vi } from 'vitest';
import { ConsultarSegmentacaoFinanceiraUseCase } from '@use-cases/billing/consultar-segmentacao-financeira.use-case';
import { ExecutarReguaInadimplenciaUseCase } from '@use-cases/billing/executar-regua-inadimplencia.use-case';
import { Billing } from '@domain/billing/billing.entity';
import { Patient } from '@domain/patient/patient.entity';
import { addCivilDays, civilDateIn } from '@domain/shared/time-zone';

const CLINIC_TIME_ZONE = 'America/Sao_Paulo';
const clinicTimeZone = { current: async () => CLINIC_TIME_ZONE };

/**
 * AD-039 — o vencimento é uma data do calendário, e os dias de atraso são
 * contados pelo calendário da clínica. "Vencida há N dias" é, então, a data
 * N dias antes de hoje NA CLÍNICA, gravada como a API a grava (meia-noite
 * UTC desse dia) — e não "agora menos N×24 h", que entre 21h e meia-noite de
 * Brasília já cai em outro dia.
 */
function dueDateDaysAgo(days: number): Date {
  const due = addCivilDays(civilDateIn(new Date(), CLINIC_TIME_ZONE), -days);
  return new Date(Date.UTC(due.year, due.month - 1, due.day));
}

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function overdueBilling(id: string, daysAgo: number) {
  const dueDate = dueDateDaysAgo(daysAgo);
  return Billing.reconstitute({ id, tenantId: TENANT_ID, patientId: `p-${id}`, amount: 400, dueDate, state: 'Atrasada' });
}

describe('ConsultarSegmentacaoFinanceiraUseCase — limiares 7 e 40 dias', () => {
  it('classifica 7 dias como em_atraso (fronteira inclusiva)', async () => {
    const repo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn(), linkSessions: vi.fn(), findOverdueByTenant: vi.fn().mockResolvedValue([overdueBilling('b1', 7)]), countLinkedSessions: vi.fn(), findSessionIdsByBillingId: vi.fn(), countOverdueByTenant: vi.fn(), sumPendingByTenant: vi.fn() };
    const useCase = new ConsultarSegmentacaoFinanceiraUseCase(repo, clinicTimeZone);
    const [result] = await useCase.execute();
    expect(result.segment).toBe('em_atraso');
  });

  it('classifica 8 dias como em_atraso, não um terceiro estágio', async () => {
    const repo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn(), linkSessions: vi.fn(), findOverdueByTenant: vi.fn().mockResolvedValue([overdueBilling('b1', 8)]), countLinkedSessions: vi.fn(), findSessionIdsByBillingId: vi.fn(), countOverdueByTenant: vi.fn(), sumPendingByTenant: vi.fn() };
    const useCase = new ConsultarSegmentacaoFinanceiraUseCase(repo, clinicTimeZone);
    const [result] = await useCase.execute();
    expect(result.segment).toBe('em_atraso');
  });

  it('classifica 40 dias como em_atraso (fronteira exata — só vira inadimplente ACIMA de 40)', async () => {
    const repo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn(), linkSessions: vi.fn(), findOverdueByTenant: vi.fn().mockResolvedValue([overdueBilling('b1', 40)]), countLinkedSessions: vi.fn(), findSessionIdsByBillingId: vi.fn(), countOverdueByTenant: vi.fn(), sumPendingByTenant: vi.fn() };
    const useCase = new ConsultarSegmentacaoFinanceiraUseCase(repo, clinicTimeZone);
    const [result] = await useCase.execute();
    expect(result.segment).toBe('em_atraso');
  });

  it('classifica 41 dias como inadimplente', async () => {
    const repo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn(), linkSessions: vi.fn(), findOverdueByTenant: vi.fn().mockResolvedValue([overdueBilling('b1', 41)]), countLinkedSessions: vi.fn(), findSessionIdsByBillingId: vi.fn(), countOverdueByTenant: vi.fn(), sumPendingByTenant: vi.fn() };
    const useCase = new ConsultarSegmentacaoFinanceiraUseCase(repo, clinicTimeZone);
    const [result] = await useCase.execute();
    expect(result.segment).toBe('inadimplente');
  });
});

describe('ExecutarReguaInadimplenciaUseCase — nunca envia mensagem em D+40, só sinaliza', () => {
  function fakePatient(id: string) {
    return Patient.reconstitute({ id, tenantId: TENANT_ID, name: 'Maria Silva', phone: '+5541900000000', state: 'Ativo' });
  }

  it('envia lembrete D+1 ao paciente', async () => {
    const segmentacao = { execute: vi.fn().mockResolvedValue([{ billingId: 'b1', patientId: 'p-b1', amount: 400, daysOverdue: 1, segment: 'em_atraso' }]) };
    const patientRepo = { findById: vi.fn().mockResolvedValue(fakePatient('p-b1')), findAllByTenant: vi.fn(), save: vi.fn(), findByPhone: vi.fn(), findAllByPhone: vi.fn(), findAllByName: vi.fn(), countActiveByTenant: vi.fn() };
    const messageQueue = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const useCase = new ExecutarReguaInadimplenciaUseCase(segmentacao as never, patientRepo, messageQueue as never);

    const result = await useCase.execute(TENANT_ID);

    expect(result.d1).toBe(1);
    expect(messageQueue.enqueue).toHaveBeenCalledOnce();
  });

  it('D+40 NUNCA envia mensagem ao paciente — apenas sinaliza', async () => {
    const segmentacao = { execute: vi.fn().mockResolvedValue([{ billingId: 'b1', patientId: 'p-b1', amount: 400, daysOverdue: 40, segment: 'em_atraso' }]) };
    const patientRepo = { findById: vi.fn().mockResolvedValue(fakePatient('p-b1')), findAllByTenant: vi.fn(), save: vi.fn(), findByPhone: vi.fn(), findAllByPhone: vi.fn(), findAllByName: vi.fn(), countActiveByTenant: vi.fn() };
    const messageQueue = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const useCase = new ExecutarReguaInadimplenciaUseCase(segmentacao as never, patientRepo, messageQueue as never);

    const result = await useCase.execute(TENANT_ID);

    expect(result.d40Signaled).toBe(1);
    expect(messageQueue.enqueue).not.toHaveBeenCalled();
  });

  it('dias fora de 1/7/40 (ex: D+15) não geram nenhuma ação', async () => {
    const segmentacao = { execute: vi.fn().mockResolvedValue([{ billingId: 'b1', patientId: 'p-b1', amount: 400, daysOverdue: 15, segment: 'em_atraso' }]) };
    const patientRepo = { findById: vi.fn().mockResolvedValue(fakePatient('p-b1')), findAllByTenant: vi.fn(), save: vi.fn(), findByPhone: vi.fn(), findAllByPhone: vi.fn(), findAllByName: vi.fn(), countActiveByTenant: vi.fn() };
    const messageQueue = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const useCase = new ExecutarReguaInadimplenciaUseCase(segmentacao as never, patientRepo, messageQueue as never);

    const result = await useCase.execute(TENANT_ID);

    expect(result.d1).toBe(0);
    expect(result.d7).toBe(0);
    expect(result.d40Signaled).toBe(0);
    expect(messageQueue.enqueue).not.toHaveBeenCalled();
  });
});
