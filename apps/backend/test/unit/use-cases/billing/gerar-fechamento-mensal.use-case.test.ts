import { describe, it, expect, vi } from 'vitest';
import { GerarFechamentoMensalUseCase } from '@use-cases/billing/gerar-fechamento-mensal.use-case';
import { Billing } from '@domain/billing/billing.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function billing(id: string, amount: number, state: 'Quitada' | 'Pendente' | 'Atrasada', dueDaysAgo = 0) {
  return Billing.reconstitute({
    id,
    tenantId: TENANT_ID,
    patientId: `p-${id}`,
    amount,
    dueDate: new Date(Date.now() - dueDaysAgo * 24 * 60 * 60 * 1000),
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
    };
    const useCase = new GerarFechamentoMensalUseCase(repo);
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
    };
    const useCase = new GerarFechamentoMensalUseCase(repo);
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
    };
    const useCase = new GerarFechamentoMensalUseCase(repo);
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
    };
    const useCase = new GerarFechamentoMensalUseCase(repo);
    const result = await useCase.execute();
    expect(result.pendingPercentage).toBe(0);
  });
});
