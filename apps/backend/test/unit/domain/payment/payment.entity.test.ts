import { describe, it, expect } from 'vitest';
import { Payment } from '@domain/payment/payment.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function newPayment(amount = 400) {
  return Payment.create({
    id: 'pay1',
    tenantId: TENANT_ID,
    billingId: 'b1',
    amount,
    method: 'pix',
    idempotencyKey: 'idem-key-001',
  });
}

describe('Payment', () => {
  it('nasce no estado Recebido', () => {
    expect(newPayment().state).toBe('Recebido');
  });

  it('rejeita criação sem idempotencyKey (RNF-008)', () => {
    expect(() =>
      Payment.create({
        id: 'pay1',
        tenantId: TENANT_ID,
        billingId: 'b1',
        amount: 400,
        method: 'pix',
        idempotencyKey: '',
      }),
    ).toThrow(/idempotencyKey/);
  });

  it('rejeita criação com valor zero ou negativo', () => {
    expect(() =>
      Payment.create({
        id: 'pay1',
        tenantId: TENANT_ID,
        billingId: 'b1',
        amount: 0,
        method: 'pix',
        idempotencyKey: 'k1',
      }),
    ).toThrow(/valor menor ou igual a zero/);
  });

  it('reconcile() confirma quando valor bate com o esperado', () => {
    const p = newPayment(400);
    p.reconcile(400);
    expect(p.state).toBe('Confirmado');
  });

  it('reconcile() marca como Divergente quando valor não bate', () => {
    const p = newPayment(350);
    p.reconcile(400);
    expect(p.state).toBe('Divergente');
  });

  it('reconcile() aceita pequena diferença de arredondamento (< 1 centavo)', () => {
    const p = newPayment(400.001);
    p.reconcile(400);
    expect(p.state).toBe('Confirmado');
  });

  it('Divergente pode ser reconciliado novamente e confirmado', () => {
    const p = newPayment(350);
    p.reconcile(400); // Divergente
    p.reconcile(350); // agora bate
    expect(p.state).toBe('Confirmado');
  });

  it('Confirmado pode ser estornado', () => {
    const p = newPayment(400);
    p.reconcile(400);
    p.transitionTo('Estornado');
    expect(p.state).toBe('Estornado');
  });

  it('Estornado é estado terminal', () => {
    const p = newPayment(400);
    p.reconcile(400);
    p.transitionTo('Estornado');
    expect(() => p.transitionTo('Confirmado')).toThrow();
  });

  it('expõe id, tenantId, billingId, amount, idempotencyKey', () => {
    const p = newPayment(400);
    expect(p.id).toBe('pay1');
    expect(p.tenantId).toBe(TENANT_ID);
    expect(p.billingId).toBe('b1');
    expect(p.amount).toBe(400);
    expect(p.idempotencyKey).toBe('idem-key-001');
  });

  it('reconstitute recria a partir de estado salvo', () => {
    const p = Payment.reconstitute({
      id: 'pay2',
      tenantId: TENANT_ID,
      billingId: 'b2',
      amount: 400,
      method: 'pix',
      idempotencyKey: 'idem-002',
      state: 'Confirmado',
    });
    expect(p.state).toBe('Confirmado');
  });
});
