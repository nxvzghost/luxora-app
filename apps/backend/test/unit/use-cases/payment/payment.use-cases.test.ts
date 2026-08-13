import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { RegistrarPagamentoUseCase, ConsultarPagamentoUseCase, EstornarPagamentoUseCase } from '@use-cases/payment/payment.use-cases';
import { Payment } from '@domain/payment/payment.entity';
import { Billing } from '@domain/billing/billing.entity';
import { Session } from '@domain/session/session.entity';
import { TenantContext } from '@shared/tenant-context';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function tenantContext() {
  const tc = new TenantContext();
  tc.set(TENANT_ID, 'user-1');
  return tc;
}

function fakeBilling(amount = 400) {
  return Billing.reconstitute({ id: 'b1', tenantId: TENANT_ID, patientId: 'p1', amount, dueDate: new Date(), state: 'Pendente' });
}

function fakeSession(id: string) {
  return Session.reconstitute({
    id,
    tenantId: TENANT_ID,
    appointmentId: `apt-${id}`,
    patientId: 'p1',
    therapistId: 't1',
    state: 'Faturada',
  });
}

/** AD-009 — sessionRepo mock que serve findById a partir dos ids fornecidos. */
function sessionRepoMock(sessionIds: string[]) {
  const sessions = new Map(sessionIds.map((id) => [id, fakeSession(id)]));
  return {
    findById: vi.fn((id: string) => Promise.resolve(sessions.get(id) ?? null)),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

describe('RegistrarPagamentoUseCase — Teste Crítico #8 (idempotência)', () => {
  it('cria o pagamento e quita a cobrança quando o valor confere', async () => {
    const paymentRepo = { findById: vi.fn(), findByIdempotencyKey: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue(undefined) };
    const billingRepo = { findById: vi.fn().mockResolvedValue(fakeBilling(400)), findAllByTenant: vi.fn(), save: vi.fn().mockResolvedValue(undefined), linkSessions: vi.fn(), countLinkedSessions: vi.fn(), findSessionIdsByBillingId: vi.fn().mockResolvedValue([]) };
    const useCase = new RegistrarPagamentoUseCase(paymentRepo, billingRepo, sessionRepoMock([]), { recordAll: vi.fn().mockResolvedValue(undefined) } as never, { process: vi.fn().mockResolvedValue(undefined) } as never, tenantContext());

    const payment = await useCase.execute({ billingId: 'b1', amount: 400, idempotencyKey: 'idem-1' });

    expect(payment.state).toBe('Confirmado');
    expect(billingRepo.save).toHaveBeenCalledOnce(); // dar baixa automático
  });

  it('marca Divergente e NÃO quita a cobrança quando o valor não confere', async () => {
    const paymentRepo = { findById: vi.fn(), findByIdempotencyKey: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue(undefined) };
    const billingRepo = { findById: vi.fn().mockResolvedValue(fakeBilling(400)), findAllByTenant: vi.fn(), save: vi.fn(), linkSessions: vi.fn(), countLinkedSessions: vi.fn(), findSessionIdsByBillingId: vi.fn() };
    const sessionRepo = sessionRepoMock(['s1']);
    const useCase = new RegistrarPagamentoUseCase(paymentRepo, billingRepo, sessionRepo, { recordAll: vi.fn().mockResolvedValue(undefined) } as never, { process: vi.fn().mockResolvedValue(undefined) } as never, tenantContext());

    const payment = await useCase.execute({ billingId: 'b1', amount: 350, idempotencyKey: 'idem-2' });

    expect(payment.state).toBe('Divergente');
    expect(billingRepo.save).not.toHaveBeenCalled();
    // AD-009: sem quitar a Billing, nenhuma Session é consultada nem transicionada
    expect(billingRepo.findSessionIdsByBillingId).not.toHaveBeenCalled();
    expect(sessionRepo.save).not.toHaveBeenCalled();
  });

  it('requisição repetida com a MESMA idempotencyKey retorna o resultado da primeira, nunca duplica', async () => {
    const primeiroPagamento = Payment.reconstitute({
      id: 'pay1', tenantId: TENANT_ID, billingId: 'b1', amount: 400, method: 'pix', idempotencyKey: 'idem-3', state: 'Confirmado',
    });
    const paymentRepo = { findById: vi.fn(), findByIdempotencyKey: vi.fn().mockResolvedValue(primeiroPagamento), save: vi.fn() };
    const billingRepo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn(), linkSessions: vi.fn(), countLinkedSessions: vi.fn(), findSessionIdsByBillingId: vi.fn() };
    const useCase = new RegistrarPagamentoUseCase(paymentRepo, billingRepo, sessionRepoMock([]), { recordAll: vi.fn().mockResolvedValue(undefined) } as never, { process: vi.fn().mockResolvedValue(undefined) } as never, tenantContext());

    const result = await useCase.execute({ billingId: 'b1', amount: 400, idempotencyKey: 'idem-3' });

    expect(result.id).toBe('pay1');
    expect(paymentRepo.save).not.toHaveBeenCalled(); // nunca tenta criar de novo
    expect(billingRepo.findById).not.toHaveBeenCalled(); // nem consulta a cobrança de novo — early return
  });

  it('lança NotFoundException quando a cobrança não existe', async () => {
    const paymentRepo = { findById: vi.fn(), findByIdempotencyKey: vi.fn().mockResolvedValue(null), save: vi.fn() };
    const billingRepo = { findById: vi.fn().mockResolvedValue(null), findAllByTenant: vi.fn(), save: vi.fn(), linkSessions: vi.fn(), countLinkedSessions: vi.fn(), findSessionIdsByBillingId: vi.fn() };
    const useCase = new RegistrarPagamentoUseCase(paymentRepo, billingRepo, sessionRepoMock([]), { recordAll: vi.fn().mockResolvedValue(undefined) } as never, { process: vi.fn().mockResolvedValue(undefined) } as never, tenantContext());
    await expect(useCase.execute({ billingId: 'b-inexistente', amount: 400, idempotencyKey: 'idem-4' })).rejects.toThrow(NotFoundException);
  });

  it('AD-009: ao quitar a cobrança, transiciona todas as Sessions vinculadas para Recebida', async () => {
    const paymentRepo = { findById: vi.fn(), findByIdempotencyKey: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue(undefined) };
    const billingRepo = {
      findById: vi.fn().mockResolvedValue(fakeBilling(400)),
      findAllByTenant: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      linkSessions: vi.fn(),
      countLinkedSessions: vi.fn(),
      findSessionIdsByBillingId: vi.fn().mockResolvedValue(['s1', 's2']),
    };
    const sessionRepo = sessionRepoMock(['s1', 's2']);
    const audit = { recordAll: vi.fn().mockResolvedValue(undefined) };
    const useCase = new RegistrarPagamentoUseCase(paymentRepo, billingRepo, sessionRepo, audit as never, { process: vi.fn().mockResolvedValue(undefined) } as never, tenantContext());

    await useCase.execute({ billingId: 'b1', amount: 400, idempotencyKey: 'idem-5' });

    expect(billingRepo.findSessionIdsByBillingId).toHaveBeenCalledWith('b1');
    expect(sessionRepo.save).toHaveBeenCalledTimes(2);
    for (const call of sessionRepo.save.mock.calls) {
      expect((call[0] as Session).state).toBe('Recebida');
    }
    // último recordAll() mescla eventos da Billing + das 2 Sessions
    const lastCallArgs = audit.recordAll.mock.calls.at(-1)?.[0];
    expect(lastCallArgs).toHaveLength(3);
  });

  it('lança NotFoundException se uma Session vinculada à cobrança quitada não existir', async () => {
    const paymentRepo = { findById: vi.fn(), findByIdempotencyKey: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue(undefined) };
    const billingRepo = {
      findById: vi.fn().mockResolvedValue(fakeBilling(400)),
      findAllByTenant: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      linkSessions: vi.fn(),
      countLinkedSessions: vi.fn(),
      findSessionIdsByBillingId: vi.fn().mockResolvedValue(['s-inexistente']),
    };
    const useCase = new RegistrarPagamentoUseCase(paymentRepo, billingRepo, sessionRepoMock([]), { recordAll: vi.fn().mockResolvedValue(undefined) } as never, { process: vi.fn().mockResolvedValue(undefined) } as never, tenantContext());
    await expect(useCase.execute({ billingId: 'b1', amount: 400, idempotencyKey: 'idem-6' })).rejects.toThrow(/não encontrada/);
  });
});

describe('ConsultarPagamentoUseCase', () => {
  it('lança NotFoundException quando não encontrado', async () => {
    const repo = { findById: vi.fn().mockResolvedValue(null), findByIdempotencyKey: vi.fn(), save: vi.fn() };
    const useCase = new ConsultarPagamentoUseCase(repo);
    await expect(useCase.execute('inexistente')).rejects.toThrow(NotFoundException);
  });
});

describe('EstornarPagamentoUseCase', () => {
  it('transiciona Confirmado → Estornado', async () => {
    const payment = Payment.reconstitute({ id: 'pay1', tenantId: TENANT_ID, billingId: 'b1', amount: 400, method: 'pix', idempotencyKey: 'k1', state: 'Confirmado' });
    const repo = { findById: vi.fn().mockResolvedValue(payment), findByIdempotencyKey: vi.fn(), save: vi.fn().mockResolvedValue(undefined) };
    const useCase = new EstornarPagamentoUseCase(repo, new ConsultarPagamentoUseCase(repo), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const result = await useCase.execute('pay1');
    expect(result.state).toBe('Estornado');
  });
});
