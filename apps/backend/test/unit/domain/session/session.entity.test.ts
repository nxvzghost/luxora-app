import { describe, it, expect } from 'vitest';
import { Session, SessionProps } from '@domain/session/session.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const AT = new Date('2026-08-01T16:00:00Z');

function billableItem(kind: 'atendimento' | 'falta' = 'atendimento') {
  return Session.createBillableItem({
    id: 's1',
    tenantId: TENANT_ID,
    appointmentId: 'a1',
    patientId: 'p1',
    therapistId: 't1',
    kind,
    at: AT,
  });
}

/** Uma sessão como as que a confirmação criava antes da K2-b: sem kind, não elegível. */
function legacy(overrides: Partial<SessionProps> = {}) {
  return Session.reconstitute({
    id: 's2',
    tenantId: TENANT_ID,
    appointmentId: 'a2',
    patientId: 'p1',
    therapistId: 't1',
    state: 'Realizada',
    billingEligibility: 'nao_elegivel',
    ...overrides,
  });
}

describe('Session — item faturável (K2-b, ADR-0069 seção 2.9)', () => {
  it('o item de um desfecho nasce a faturar, elegível, com o kind e o momento do registro', () => {
    const s = billableItem();
    expect(s.state).toBe('Realizada');
    expect(s.kind).toBe('atendimento');
    expect(s.billingEligibility).toBe('elegivel');
    expect(s.completedAt).toEqual(AT);
    expect(s.isBillable).toBe(true);
  });

  it('o item de falta também é elegível', () => {
    expect(billableItem('falta').isBillable).toBe(true);
  });

  it('percorre o fluxo até Recebida, e Recebida é terminal', () => {
    const s = billableItem();
    s.transitionTo('Faturada');
    s.transitionTo('Recebida');
    expect(s.state).toBe('Recebida');
    expect(() => s.transitionTo('Faturada')).toThrow();
  });

  it('não permite pular direto de Realizada para Recebida', () => {
    expect(() => billableItem().transitionTo('Recebida')).toThrow();
  });

  it('emite evento de criação com fromState null', () => {
    const events = billableItem().pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe('SessaoEstadoAlterado');
  });

  it('expõe appointmentId, patientId, id, tenantId', () => {
    const s = billableItem();
    expect([s.appointmentId, s.patientId, s.id, s.tenantId]).toEqual(['a1', 'p1', 's1', TENANT_ID]);
  });

  it('reconstitute recria a partir de estado salvo', () => {
    expect(legacy({ state: 'Faturada' }).state).toBe('Faturada');
  });

  describe('isBillable — falha fechada', () => {
    it('sessão legada (sem kind, não elegível) não pode ser cobrada', () => {
      expect(legacy().isBillable).toBe(false);
    });

    it('elegível mas sem kind: não (o banco também recusa essa linha)', () => {
      expect(legacy({ billingEligibility: 'elegivel' }).isBillable).toBe(false);
    });

    it('com kind, mas não elegível: não', () => {
      expect(legacy({ kind: 'atendimento' }).isBillable).toBe(false);
    });

    it('anulada: não', () => {
      expect(legacy({ kind: 'atendimento', billingEligibility: 'elegivel', voidedAt: AT, voidReason: 'desfecho_corrigido' }).isBillable).toBe(false);
    });

    it('já faturada: não', () => {
      const s = billableItem();
      s.transitionTo('Faturada');
      expect(s.isBillable).toBe(false);
      expect(s.isBilled).toBe(true);
    });
  });

  describe('makeBillable — reaproveita a sessão que já existe, nunca recria (seção 2.8)', () => {
    it('a sessão legada passa a ser o item do desfecho registrado', () => {
      const s = legacy();
      expect(s.makeBillable('atendimento', AT)).toBe('applied');
      expect([s.kind, s.billingEligibility, s.completedAt, s.isBillable]).toEqual(['atendimento', 'elegivel', AT, true]);
      expect(s.pullDomainEvents().map((e) => e.eventName)).toEqual(['SessaoTornadaElegivel']);
    });

    it('uma anulação é desfeita', () => {
      const s = legacy({ kind: 'atendimento', voidedAt: AT, voidReason: 'legado_consulta_futura', voidedByUserId: 'u1' });
      s.makeBillable('atendimento', AT);
      expect([s.voidedAt, s.voidReason, s.voidedByUserId, s.isBillable]).toEqual([undefined, undefined, undefined, true]);
    });

    it('repetir com o mesmo kind não muda nada nem gera evento', () => {
      const s = billableItem();
      s.pullDomainEvents();
      expect(s.makeBillable('atendimento', new Date())).toBe('unchanged');
      expect(s.completedAt).toEqual(AT);
      expect(s.pullDomainEvents()).toHaveLength(0);
    });

    it('trocar o kind de um item já definido é correção de desfecho (fora desta fase): recusado', () => {
      expect(() => billableItem('atendimento').makeBillable('falta', AT)).toThrow(/correção de desfecho/);
    });

    it('sessão já cobrada não muda de item', () => {
      expect(() => legacy({ state: 'Faturada' }).makeBillable('atendimento', AT)).toThrow(/já cobrada/);
    });
  });
});
