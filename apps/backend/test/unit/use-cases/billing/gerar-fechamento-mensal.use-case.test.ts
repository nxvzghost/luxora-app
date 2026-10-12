import { describe, it, expect, vi } from 'vitest';
import { GerarFechamentoMensalUseCase } from '@use-cases/billing/gerar-fechamento-mensal.use-case';
import { Billing } from '@domain/billing/billing.entity';
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

function billing(id: string, amount: number, state: 'Quitada' | 'Pendente' | 'Atrasada', dueDaysAgo = 0) {
  return Billing.reconstitute({
    id,
    tenantId: TENANT_ID,
    patientId: `p-${id}`,
    amount,
    dueDate: dueDateDaysAgo(dueDaysAgo),
    state,
  });
}

describe('GerarFechamentoMensalUseCase', () => {
  it('calcula total, recebido e pendente corretamente', async () => {
    const repo = {
      findById: vi.fn(),
      findAllByTenant: vi.fn().mockResolvedValue([billing('b1', 400, 'Quitada'), billing('b2', 600, 'Pendente')]),
      save: vi.fn(),
      linkSessions: vi.fn(),
      findOverdueByTenant: vi.fn(),
      countLinkedSessions: vi.fn(),
      findSessionIdsByBillingId: vi.fn(),
      countOverdueByTenant: vi.fn(),
      sumPendingByTenant: vi.fn(),
    };
    const useCase = new GerarFechamentoMensalUseCase(repo, clinicTimeZone);
    const result = await useCase.execute();

    expect(result.totalAppointmentsValue).toBe(1000);
    expect(result.received).toBe(400);
    expect(result.pending).toBe(600);
    expect(result.pendingPercentage).toBe(60);
  });

  it('classifica pendências por paciente com status correto', async () => {
    const repo = {
      findById: vi.fn(),
      findAllByTenant: vi.fn().mockResolvedValue([billing('b1', 400, 'Atrasada', 45)]),
      save: vi.fn(),
      linkSessions: vi.fn(),
      findOverdueByTenant: vi.fn(),
      countLinkedSessions: vi.fn(),
      findSessionIdsByBillingId: vi.fn(),
      countOverdueByTenant: vi.fn(),
      sumPendingByTenant: vi.fn(),
    };
    const useCase = new GerarFechamentoMensalUseCase(repo, clinicTimeZone);
    const result = await useCase.execute();

    expect(result.pendingByPatient).toHaveLength(1);
    expect(result.pendingByPatient[0].status).toBe('inadimplente');
  });

  it('gera conclusão objetiva a partir dos números', async () => {
    const repo = {
      findById: vi.fn(),
      findAllByTenant: vi.fn().mockResolvedValue([billing('b1', 1000, 'Quitada')]),
      save: vi.fn(),
      linkSessions: vi.fn(),
      findOverdueByTenant: vi.fn(),
      countLinkedSessions: vi.fn(),
      findSessionIdsByBillingId: vi.fn(),
      countOverdueByTenant: vi.fn(),
      sumPendingByTenant: vi.fn(),
    };
    const useCase = new GerarFechamentoMensalUseCase(repo, clinicTimeZone);
    const result = await useCase.execute();
    expect(result.conclusion).toContain('R$ 1000.00');
    expect(result.conclusion).toContain('0.0%');
  });

  it('não quebra com nenhuma cobrança (divisão por zero)', async () => {
    const repo = {
      findById: vi.fn(),
      findAllByTenant: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      linkSessions: vi.fn(),
      findOverdueByTenant: vi.fn(),
      countLinkedSessions: vi.fn(),
      findSessionIdsByBillingId: vi.fn(),
      countOverdueByTenant: vi.fn(),
      sumPendingByTenant: vi.fn(),
    };
    const useCase = new GerarFechamentoMensalUseCase(repo, clinicTimeZone);
    const result = await useCase.execute();
    expect(result.pendingPercentage).toBe(0);
  });
});
