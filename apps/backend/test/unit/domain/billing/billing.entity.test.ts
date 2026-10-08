import { describe, it, expect } from 'vitest';
import { AWAITING_PAYMENT_STATES, Billing, BillingState, overdueDueDateCutoff } from '@domain/billing/billing.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function newBilling(dueDate = new Date('2026-08-01T00:00:00Z')) {
  return Billing.create({
    id: 'b1',
    tenantId: TENANT_ID,
    patientId: 'p1',
    amount: 400,
    dueDate,
  });
}

describe('Billing', () => {
  it('nasce no estado Criada', () => {
    expect(newBilling().state).toBe('Criada');
  });

  it('rejeita criação com valor zero ou negativo', () => {
    expect(() =>
      Billing.create({ id: 'b1', tenantId: TENANT_ID, patientId: 'p1', amount: 0, dueDate: new Date() }),
    ).toThrow(/valor menor ou igual a zero/);
    expect(() =>
      Billing.create({ id: 'b1', tenantId: TENANT_ID, patientId: 'p1', amount: -10, dueDate: new Date() }),
    ).toThrow();
  });

  it('percorre o fluxo feliz até Quitada', () => {
    const b = newBilling();
    b.transitionTo('Enviada');
    b.transitionTo('Pendente');
    b.transitionTo('Quitada');
    expect(b.state).toBe('Quitada');
  });

  it('percorre o fluxo de inadimplência: Pendente → Atrasada → Escalada → Negociada → Quitada', () => {
    const b = newBilling();
    b.transitionTo('Enviada');
    b.transitionTo('Pendente');
    b.transitionTo('Atrasada');
    b.transitionTo('Escalada');
    b.transitionTo('Negociada');
    b.transitionTo('Quitada');
    expect(b.state).toBe('Quitada');
  });

  it('não permite cancelar diretamente a partir de Atrasada (exige decisão humana)', () => {
    const b = newBilling();
    b.transitionTo('Enviada');
    b.transitionTo('Pendente');
    b.transitionTo('Atrasada');
    expect(() => b.transitionTo('Cancelada')).toThrow();
  });

  it('Quitada e Cancelada são estados terminais', () => {
    const quitada = newBilling();
    quitada.transitionTo('Enviada');
    quitada.transitionTo('Pendente');
    quitada.transitionTo('Quitada');
    expect(() => quitada.transitionTo('Pendente')).toThrow();

    const cancelada = newBilling();
    cancelada.transitionTo('Cancelada');
    expect(() => cancelada.transitionTo('Enviada')).toThrow();
  });

  it('daysOverdue retorna 0 antes do vencimento', () => {
    const b = newBilling(new Date('2026-08-10T00:00:00Z'));
    expect(b.daysOverdue(new Date('2026-08-05T00:00:00Z'))).toBe(0);
  });

  it('daysOverdue calcula corretamente dias após o vencimento', () => {
    const b = newBilling(new Date('2026-08-01T00:00:00Z'));
    expect(b.daysOverdue(new Date('2026-08-08T00:00:00Z'))).toBe(7);
  });

  it('daysOverdue na fronteira exata de 40 dias', () => {
    const b = newBilling(new Date('2026-08-01T00:00:00Z'));
    expect(b.daysOverdue(new Date('2026-09-10T00:00:00Z'))).toBe(40);
  });

  it('expõe id, tenantId, patientId, amount, dueDate', () => {
    const dueDate = new Date('2026-08-01T00:00:00Z');
    const b = newBilling(dueDate);
    expect(b.id).toBe('b1');
    expect(b.tenantId).toBe(TENANT_ID);
    expect(b.patientId).toBe('p1');
    expect(b.amount).toBe(400);
    expect(b.dueDate).toEqual(dueDate);
  });

  it('emite evento a cada transição', () => {
    const b = newBilling();
    b.transitionTo('Enviada');
    const events = b.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe('CobrancaEstadoAlterado');
  });

  it('reconstitute recria a partir de estado salvo', () => {
    const b = Billing.reconstitute({
      id: 'b2',
      tenantId: TENANT_ID,
      patientId: 'p1',
      amount: 1200,
      dueDate: new Date(),
      state: 'Atrasada',
    });
    expect(b.state).toBe('Atrasada');
  });
});

/**
 * Tarefa 05 da auditoria — "em atraso" calculado pelo vencimento, sem
 * transição nova: nenhum fluxo leva uma cobrança até `Atrasada`, e os
 * indicadores do painel contavam só esse estado.
 */
describe('Billing.isOverdue — em atraso pelo vencimento', () => {
  const DUE = new Date('2026-08-10T00:00:00Z');
  const ONE_DAY_LATER = new Date('2026-08-11T00:00:00Z');
  const A_MONTH_LATER = new Date('2026-09-10T12:00:00Z');

  function billingIn(state: BillingState, dueDate: Date = DUE) {
    return Billing.reconstitute({ id: 'b1', tenantId: TENANT_ID, patientId: 'p1', amount: 400, dueDate, state });
  }

  it.each(['Criada', 'Enviada', 'Visualizada', 'Pendente'] as const)('%s com o vencimento passado está em atraso', (state) => {
    expect(billingIn(state).isOverdue(A_MONTH_LATER)).toBe(true);
  });

  it.each(['Criada', 'Enviada', 'Visualizada', 'Pendente'] as const)('%s antes do vencimento não está em atraso', (state) => {
    expect(billingIn(state).isOverdue(new Date('2026-08-05T00:00:00Z'))).toBe(false);
  });

  it('o dia do vencimento ainda está em dia; o atraso começa um dia inteiro depois', () => {
    const billing = billingIn('Enviada');

    expect(billing.isOverdue(DUE)).toBe(false);
    expect(billing.isOverdue(new Date('2026-08-10T23:59:59.999Z'))).toBe(false);
    expect(billing.isOverdue(ONE_DAY_LATER)).toBe(true);
  });

  it('usa a mesma régua de daysOverdue: em atraso exatamente quando há 1 dia ou mais', () => {
    const billing = billingIn('Criada');
    for (const reference of [DUE, new Date('2026-08-10T23:59:59.999Z'), ONE_DAY_LATER, new Date('2026-08-17T00:00:00Z'), A_MONTH_LATER]) {
      expect(billing.isOverdue(reference)).toBe(billing.daysOverdue(reference) >= 1);
    }
  });

  it.each(['Quitada', 'Cancelada'] as const)('%s nunca está em atraso, por mais antigo que seja o vencimento', (state) => {
    expect(billingIn(state).isOverdue(A_MONTH_LATER)).toBe(false);
  });

  it.each(['Negociada', 'Escalada'] as const)('%s continua fora da contagem, como já estava', (state) => {
    expect(billingIn(state).isOverdue(A_MONTH_LATER)).toBe(false);
  });

  it('Atrasada continua em atraso, como já era — o estado gravado prevalece', () => {
    expect(billingIn('Atrasada').isOverdue(A_MONTH_LATER)).toBe(true);
    expect(billingIn('Atrasada').isOverdue(new Date('2026-08-05T00:00:00Z'))).toBe(true);
  });

  it('sem vencimento válido não há atraso por data', () => {
    expect(billingIn('Enviada', new Date(Number.NaN)).isOverdue(A_MONTH_LATER)).toBe(false);
    expect(billingIn('Enviada', null as unknown as Date).isOverdue(A_MONTH_LATER)).toBe(false);
  });

  it('não muda o estado nem emite evento: é só leitura', () => {
    const billing = billingIn('Enviada');

    billing.isOverdue(A_MONTH_LATER);

    expect(billing.state).toBe('Enviada');
    expect(billing.pullDomainEvents()).toHaveLength(0);
  });

  it('a lista de estados que aguardam pagamento é a usada pela contagem no banco', () => {
    expect([...AWAITING_PAYMENT_STATES]).toEqual(['Criada', 'Enviada', 'Visualizada', 'Pendente']);
    expect(overdueDueDateCutoff(ONE_DAY_LATER)).toEqual(DUE);
  });
});
