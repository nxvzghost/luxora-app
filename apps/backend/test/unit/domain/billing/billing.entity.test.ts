import { describe, it, expect } from 'vitest';
import { AWAITING_PAYMENT_STATES, Billing, BillingState, overdueDueDateLimit } from '@domain/billing/billing.entity';

/** A clínica destes testes. São Paulo está 3 h atrás do UTC o ano inteiro: 00:00 lá é 03:00Z. */
const SAO_PAULO = 'America/Sao_Paulo';

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
    expect(b.daysOverdue(SAO_PAULO, new Date('2026-08-05T15:00:00Z'))).toBe(0);
  });

  it('daysOverdue calcula corretamente dias após o vencimento', () => {
    const b = newBilling(new Date('2026-08-01T00:00:00Z'));
    expect(b.daysOverdue(SAO_PAULO, new Date('2026-08-08T15:00:00Z'))).toBe(7);
  });

  it('daysOverdue na fronteira exata de 40 dias', () => {
    const b = newBilling(new Date('2026-08-01T00:00:00Z'));
    expect(b.daysOverdue(SAO_PAULO, new Date('2026-09-10T15:00:00Z'))).toBe(40);
  });

  // AD-039 — o dia vira à meia-noite da clínica (03:00Z), não à meia-noite UTC.
  it('daysOverdue conta dias do calendário da clínica: muda à meia-noite de lá, não à do UTC', () => {
    const b = newBilling(new Date('2026-08-01T00:00:00Z'));
    expect(b.daysOverdue(SAO_PAULO, new Date('2026-08-08T00:00:00Z'))).toBe(6); // 21:00 do dia 7 em São Paulo
    expect(b.daysOverdue(SAO_PAULO, new Date('2026-08-08T02:59:59.999Z'))).toBe(6); // 23:59 do dia 7
    expect(b.daysOverdue(SAO_PAULO, new Date('2026-08-08T03:00:00Z'))).toBe(7); // 00:00 do dia 8
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
 *
 * AD-039 (ADR-0064) — o dia do vencimento é o da clínica. A cobrança
 * continua em dia até o último instante desse dia no fuso dela e passa a
 * estar em atraso à meia-noite seguinte, também no fuso dela. Antes o corte
 * era a meia-noite UTC: 21h de Brasília do próprio dia do vencimento.
 */
describe('Billing.isOverdue — em atraso pelo vencimento, no dia do calendário da clínica', () => {
  /** Vence em 10/08/2026 — gravado como a API grava uma data: meia-noite UTC desse dia. */
  const DUE = new Date('2026-08-10T00:00:00Z');
  const DUE_DAY_STARTS = new Date('2026-08-10T03:00:00Z'); // 00:00 de 10/08 em São Paulo
  const OLD_CUTOFF = new Date('2026-08-11T00:00:00Z'); // 21:00 de 10/08 em São Paulo — onde o corte antigo caía
  const LAST_INSTANT_OF_DUE_DAY = new Date('2026-08-11T02:59:59.999Z'); // 23:59:59,999 de 10/08 em São Paulo
  const NEXT_DAY_STARTS = new Date('2026-08-11T03:00:00Z'); // 00:00 de 11/08 em São Paulo
  const A_MONTH_LATER = new Date('2026-09-10T12:00:00Z');

  function billingIn(state: BillingState, dueDate: Date = DUE) {
    return Billing.reconstitute({ id: 'b1', tenantId: TENANT_ID, patientId: 'p1', amount: 400, dueDate, state });
  }

  it.each(['Criada', 'Enviada', 'Visualizada', 'Pendente'] as const)('%s com o vencimento passado está em atraso', (state) => {
    expect(billingIn(state).isOverdue(SAO_PAULO, A_MONTH_LATER)).toBe(true);
  });

  it.each(['Criada', 'Enviada', 'Visualizada', 'Pendente'] as const)('%s antes do vencimento não está em atraso', (state) => {
    expect(billingIn(state).isOverdue(SAO_PAULO, new Date('2026-08-05T15:00:00Z'))).toBe(false);
  });

  it('o dia do vencimento está em dia do primeiro ao último instante, no fuso da clínica', () => {
    const billing = billingIn('Enviada');

    expect(billing.isOverdue(SAO_PAULO, DUE_DAY_STARTS)).toBe(false);
    expect(billing.isOverdue(SAO_PAULO, new Date('2026-08-10T15:00:00Z'))).toBe(false); // meio-dia
    expect(billing.isOverdue(SAO_PAULO, LAST_INSTANT_OF_DUE_DAY)).toBe(false);
  });

  it('o atraso começa à meia-noite do dia seguinte, no fuso da clínica', () => {
    const billing = billingIn('Enviada');

    expect(billing.isOverdue(SAO_PAULO, LAST_INSTANT_OF_DUE_DAY)).toBe(false);
    expect(billing.isOverdue(SAO_PAULO, NEXT_DAY_STARTS)).toBe(true);
  });

  it('às 21h de Brasília do dia do vencimento (o corte antigo, meia-noite UTC) a cobrança ainda está em dia', () => {
    expect(billingIn('Enviada').isOverdue(SAO_PAULO, OLD_CUTOFF)).toBe(false);
    expect(billingIn('Enviada').daysOverdue(SAO_PAULO, OLD_CUTOFF)).toBe(0);
  });

  it('na véspera do vencimento, mesmo já sendo o dia do vencimento em UTC, não há atraso', () => {
    // 22:00 de 09/08 em São Paulo é 01:00Z de 10/08.
    expect(billingIn('Enviada').isOverdue(SAO_PAULO, new Date('2026-08-10T01:00:00Z'))).toBe(false);
  });

  it('clínicas em fusos diferentes, no mesmo instante: cada uma no seu dia', () => {
    const billing = billingIn('Enviada');
    const instant = new Date('2026-08-11T03:30:00Z');

    expect(billing.isOverdue(SAO_PAULO, instant)).toBe(true); // 00:30 de 11/08
    expect(billing.isOverdue('America/Manaus', instant)).toBe(false); // 23:30 de 10/08
    expect(billing.isOverdue('America/Rio_Branco', instant)).toBe(false); // 22:30 de 10/08
    expect(billing.isOverdue('Asia/Tokyo', instant)).toBe(true); // 12:30 de 11/08
    expect(billing.isOverdue('UTC', instant)).toBe(true); // 03:30 de 11/08
  });

  it('fuso à frente do UTC: o atraso começa antes da meia-noite UTC', () => {
    const billing = billingIn('Enviada');

    // Tóquio está 9 h à frente: 00:00 de 11/08 lá é 15:00Z de 10/08.
    expect(billing.isOverdue('Asia/Tokyo', new Date('2026-08-10T14:59:59.999Z'))).toBe(false);
    expect(billing.isOverdue('Asia/Tokyo', new Date('2026-08-10T15:00:00Z'))).toBe(true);
    expect(billing.isOverdue(SAO_PAULO, new Date('2026-08-10T15:00:00Z'))).toBe(false);
  });

  it('vencimento gravado com hora (não à meia-noite UTC) vale pela data: o dia inteiro em dia, atraso no dia seguinte', () => {
    const billing = billingIn('Enviada', new Date('2026-08-10T15:30:00Z'));

    expect(billing.isOverdue(SAO_PAULO, LAST_INSTANT_OF_DUE_DAY)).toBe(false);
    expect(billing.isOverdue(SAO_PAULO, NEXT_DAY_STARTS)).toBe(true);
    expect(billing.daysOverdue(SAO_PAULO, NEXT_DAY_STARTS)).toBe(1);
  });

  it('usa a mesma régua de daysOverdue: em atraso exatamente quando há 1 dia ou mais', () => {
    const billing = billingIn('Criada');
    const references = [DUE, DUE_DAY_STARTS, OLD_CUTOFF, LAST_INSTANT_OF_DUE_DAY, NEXT_DAY_STARTS, new Date('2026-08-17T00:00:00Z'), A_MONTH_LATER];
    for (const timeZone of [SAO_PAULO, 'America/Manaus', 'UTC', 'Asia/Tokyo', 'America/New_York']) {
      for (const reference of references) {
        expect(billing.isOverdue(timeZone, reference), `${timeZone} em ${reference.toISOString()}`).toBe(billing.daysOverdue(timeZone, reference) >= 1);
      }
    }
  });

  it('o resultado não depende do fuso do processo (contêiner em UTC, máquina em Brasília, ou qualquer outro)', () => {
    const original = process.env.TZ;
    try {
      for (const processTimeZone of ['UTC', 'America/Sao_Paulo', 'Asia/Tokyo', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
        process.env.TZ = processTimeZone;
        const billing = billingIn('Enviada');
        expect(billing.isOverdue(SAO_PAULO, LAST_INSTANT_OF_DUE_DAY), processTimeZone).toBe(false);
        expect(billing.isOverdue(SAO_PAULO, NEXT_DAY_STARTS), processTimeZone).toBe(true);
        expect(billing.daysOverdue(SAO_PAULO, new Date('2026-08-17T03:00:00Z')), processTimeZone).toBe(7);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it.each(['Quitada', 'Cancelada'] as const)('%s nunca está em atraso, por mais antigo que seja o vencimento', (state) => {
    expect(billingIn(state).isOverdue(SAO_PAULO, A_MONTH_LATER)).toBe(false);
  });

  it.each(['Negociada', 'Escalada'] as const)('%s continua fora da contagem, como já estava', (state) => {
    expect(billingIn(state).isOverdue(SAO_PAULO, A_MONTH_LATER)).toBe(false);
  });

  it('Atrasada continua em atraso, como já era — o estado gravado prevalece', () => {
    expect(billingIn('Atrasada').isOverdue(SAO_PAULO, A_MONTH_LATER)).toBe(true);
    expect(billingIn('Atrasada').isOverdue(SAO_PAULO, new Date('2026-08-05T00:00:00Z'))).toBe(true);
  });

  it('sem vencimento válido não há atraso por data', () => {
    expect(billingIn('Enviada', new Date(Number.NaN)).isOverdue(SAO_PAULO, A_MONTH_LATER)).toBe(false);
    expect(billingIn('Enviada', null as unknown as Date).isOverdue(SAO_PAULO, A_MONTH_LATER)).toBe(false);
  });

  it('não muda o estado nem emite evento: é só leitura', () => {
    const billing = billingIn('Enviada');

    billing.isOverdue(SAO_PAULO, A_MONTH_LATER);

    expect(billing.state).toBe('Enviada');
    expect(billing.pullDomainEvents()).toHaveLength(0);
  });

  it('a lista de estados que aguardam pagamento é a usada pela contagem no banco', () => {
    expect([...AWAITING_PAYMENT_STATES]).toEqual(['Criada', 'Enviada', 'Visualizada', 'Pendente']);
  });

  it('o corte usado pela contagem no banco é a meia-noite UTC do dia que é "hoje" na clínica', () => {
    expect(overdueDueDateLimit(SAO_PAULO, LAST_INSTANT_OF_DUE_DAY)).toEqual(new Date('2026-08-10T00:00:00Z'));
    expect(overdueDueDateLimit(SAO_PAULO, NEXT_DAY_STARTS)).toEqual(new Date('2026-08-11T00:00:00Z'));
    expect(overdueDueDateLimit('Asia/Tokyo', new Date('2026-08-10T15:00:00Z'))).toEqual(new Date('2026-08-11T00:00:00Z'));
  });

  it('o corte do banco e isOverdue dão a mesma resposta para qualquer vencimento, instante e fuso', () => {
    const dueDates = ['2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12'].map((day) => new Date(`${day}T00:00:00Z`));
    const references = [OLD_CUTOFF, LAST_INSTANT_OF_DUE_DAY, NEXT_DAY_STARTS, new Date('2026-08-10T14:59:59.999Z'), new Date('2026-08-10T15:00:00Z')];
    for (const timeZone of [SAO_PAULO, 'America/Manaus', 'UTC', 'Asia/Tokyo']) {
      for (const reference of references) {
        for (const dueDate of dueDates) {
          const byFilter = dueDate.getTime() < overdueDueDateLimit(timeZone, reference).getTime();
          expect(billingIn('Enviada', dueDate).isOverdue(timeZone, reference), `${timeZone}, vence ${dueDate.toISOString()}, em ${reference.toISOString()}`).toBe(byFilter);
        }
      }
    }
  });
});
