import { describe, it, expect } from 'vitest';
import { ScheduleSlot } from '@domain/availability/schedule-slot.value-object';

function slot(startHour: number, endHour: number) {
  return ScheduleSlot.free(
    't1',
    new Date(`2026-08-01T${String(startHour).padStart(2, '0')}:00:00Z`),
    new Date(`2026-08-01T${String(endHour).padStart(2, '0')}:00:00Z`),
  );
}

describe('ScheduleSlot', () => {
  it('nasce no estado Livre', () => {
    expect(slot(15, 16).state).toBe('Livre');
  });

  it('isAvailable é true apenas quando Livre', () => {
    const s = slot(15, 16);
    expect(s.isAvailable).toBe(true);
    s.transitionTo('Reservado');
    expect(s.isAvailable).toBe(false);
  });

  it('rejeita criação com início posterior ou igual ao fim', () => {
    expect(() =>
      ScheduleSlot.free('t1', new Date('2026-08-01T16:00:00Z'), new Date('2026-08-01T15:00:00Z')),
    ).toThrow(/início deve ser anterior ao fim/);
  });

  it('percorre o fluxo feliz: Livre → Reservado → Confirmado → Livre', () => {
    const s = slot(15, 16);
    s.transitionTo('Reservado');
    s.transitionTo('Confirmado');
    s.transitionTo('Livre');
    expect(s.state).toBe('Livre');
  });

  it('permite bloqueio manual a partir de Livre', () => {
    const s = slot(15, 16);
    s.transitionTo('Bloqueado');
    expect(s.state).toBe('Bloqueado');
    s.transitionTo('Livre');
    expect(s.state).toBe('Livre');
  });

  it('permite marcar como Indisponível e voltar a Livre', () => {
    const s = slot(15, 16);
    s.transitionTo('Indisponivel');
    s.transitionTo('Livre');
    expect(s.state).toBe('Livre');
  });

  it('rejeita reserva direta de um horário Bloqueado', () => {
    const s = slot(15, 16);
    s.transitionTo('Bloqueado');
    expect(() => s.transitionTo('Reservado')).toThrow();
  });

  describe('overlapsWith — teste crítico #10 (conflito de agenda)', () => {
    it('detecta sobreposição parcial', () => {
      expect(slot(15, 17).overlapsWith(slot(16, 18))).toBe(true);
    });

    it('detecta sobreposição total (mesmo horário exato)', () => {
      expect(slot(15, 16).overlapsWith(slot(15, 16))).toBe(true);
    });

    it('não detecta sobreposição quando horários são adjacentes (fim = início do outro)', () => {
      expect(slot(14, 15).overlapsWith(slot(15, 16))).toBe(false);
    });

    it('não detecta sobreposição quando horários estão distantes', () => {
      expect(slot(10, 11).overlapsWith(slot(15, 16))).toBe(false);
    });
  });
});
