import { describe, it, expect } from 'vitest';
import { Billing } from '@domain/billing/billing.entity';

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
