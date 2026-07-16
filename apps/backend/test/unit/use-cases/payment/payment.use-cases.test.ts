import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { RegistrarPagamentoUseCase, ConsultarPagamentoUseCase, EstornarPagamentoUseCase } from '@use-cases/payment/payment.use-cases';
import { Payment } from '@domain/payment/payment.entity';
import { Billing } from '@domain/billing/billing.entity';
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

describe('RegistrarPagamentoUseCase — Teste Crítico #8 (idempotência)', () => {
  it('cria o pagamento e quita a cobrança quando o valor confere', async () => {
    const paymentRepo = { findById: vi.fn(), findByIdempotencyKey: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue(undefined) };
    const billingRepo = { findById: vi.fn().mockResolvedValue(fakeBilling(400)), findAllByTenant: vi.fn(), save: vi.fn().mockResolvedValue(undefined), linkSessions: vi.fn(), countLinkedSessions: vi.fn() };
    const useCase = new RegistrarPagamentoUseCase(paymentRepo, billingRepo, { recordAll: vi.fn().mockResolvedValue(undefined) } as never, tenantContext());

    const payment = await useCase.execute({ billingId: 'b1', amount: 400, idempotencyKey: 'idem-1' });

    expect(payment.state).toBe('Confirmado');
    expect(billingRepo.save).toHaveBeenCalledOnce(); // dar baixa automático
  });

  it('marca Divergente e NÃO quita a cobrança quando o valor não confere', async () => {
    const paymentRepo = { findById: vi.fn(), findByIdempotencyKey: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue(undefined) };
    const billingRepo = { findById: vi.fn().mockResolvedValue(fakeBilling(400)), findAllByTenant: vi.fn(), save: vi.fn(), linkSessions: vi.fn(), countLinkedSessions: vi.fn() };
    const useCase = new RegistrarPagamentoUseCase(paymentRepo, billingRepo, { recordAll: vi.fn().mockResolvedValue(undefined) } as never, tenantContext());

    const payment = await useCase.execute({ billingId: 'b1', amount: 350, idempotencyKey: 'idem-2' });

    expect(payment.state).toBe('Divergente');
    expect(billingRepo.save).not.toHaveBeenCalled();
  });

  it('requisição repetida com a MESMA idempotencyKey retorna o resultado da primeira, nunca duplica', async () => {
    const primeiroPagamento = Payment.reconstitute({
      id: 'pay1', tenantId: TENANT_ID, billingId: 'b1', amount: 400, method: 'pix', idempotencyKey: 'idem-3', state: 'Confirmado',
    });
    const paymentRepo = { findById: vi.fn(), findByIdempotencyKey: vi.fn().mockResolvedValue(primeiroPagamento), save: vi.fn() };
    const billingRepo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn(), linkSessions: vi.fn(), countLinkedSessions: vi.fn() };
    const useCase = new RegistrarPagamentoUseCase(paymentRepo, billingRepo, { recordAll: vi.fn().mockResolvedValue(undefined) } as never, tenantContext());

    const result = await useCase.execute({ billingId: 'b1', amount: 400, idempotencyKey: 'idem-3' });

    expect(result.id).toBe('pay1');
    expect(paymentRepo.save).not.toHaveBeenCalled(); // nunca tenta criar de novo
    expect(billingRepo.findById).not.toHaveBeenCalled(); // nem consulta a cobrança de novo — early return
  });

  it('lança NotFoundException quando a cobrança não existe', async () => {
    const paymentRepo = { findById: vi.fn(), findByIdempotencyKey: vi.fn().mockResolvedValue(null), save: vi.fn() };
    const billingRepo = { findById: vi.fn().mockResolvedValue(null), findAllByTenant: vi.fn(), save: vi.fn(), linkSessions: vi.fn(), countLinkedSessions: vi.fn() };
    const useCase = new RegistrarPagamentoUseCase(paymentRepo, billingRepo, { recordAll: vi.fn().mockResolvedValue(undefined) } as never, tenantContext());
    await expect(useCase.execute({ billingId: 'b-inexistente', amount: 400, idempotencyKey: 'idem-4' })).rejects.toThrow(NotFoundException);
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
