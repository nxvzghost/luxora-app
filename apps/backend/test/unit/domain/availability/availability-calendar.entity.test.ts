import { describe, it, expect } from 'vitest';
import { AvailabilityCalendar, DEFAULT_SESSION_DURATION_MINUTES } from '@domain/availability/availability-calendar.entity';
import { ScheduleSlot } from '@domain/availability/schedule-slot.value-object';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function newCalendar() {
  return AvailabilityCalendar.create({ id: 'cal1', tenantId: TENANT_ID, therapistId: 't1' });
}

// 2026-08-03 é uma segunda-feira (dayOfWeek 1)
function calendarWithMondayMorning(sessionDurationMinutes = 50) {
  const cal = newCalendar();
  cal.setWindows([{ dayOfWeek: 1, startTime: '09:00', endTime: '11:00', sessionDurationMinutes }]);
  return cal;
}

describe('AvailabilityCalendar', () => {
  it('nasce sem janelas', () => {
    expect(newCalendar().windows).toHaveLength(0);
  });

  it('expõe id, tenantId, therapistId', () => {
    const cal = newCalendar();
    expect(cal.id).toBe('cal1');
    expect(cal.tenantId).toBe(TENANT_ID);
    expect(cal.therapistId).toBe('t1');
  });

  describe('setWindows', () => {
    it('aceita janelas válidas, com duração própria', () => {
      const cal = newCalendar();
      cal.setWindows([{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00', sessionDurationMinutes: 45 }]);
      expect(cal.windows).toHaveLength(1);
      expect(cal.windows[0].sessionDurationMinutes).toBe(45);
    });

    it('substitui as janelas inteiras (não faz merge)', () => {
      const cal = newCalendar();
      cal.setWindows([{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00', sessionDurationMinutes: 60 }]);
      cal.setWindows([{ dayOfWeek: 2, startTime: '14:00', endTime: '18:00', sessionDurationMinutes: 60 }]);
      expect(cal.windows).toHaveLength(1);
      expect(cal.windows[0].dayOfWeek).toBe(2);
    });

    it('rejeita dayOfWeek fora do intervalo 0-6', () => {
      const cal = newCalendar();
      expect(() =>
        cal.setWindows([{ dayOfWeek: 7, startTime: '09:00', endTime: '12:00', sessionDurationMinutes: 60 }]),
      ).toThrow(/dayOfWeek inválido/);
    });

    it('rejeita horário em formato inválido', () => {
      const cal = newCalendar();
      expect(() =>
        cal.setWindows([{ dayOfWeek: 1, startTime: '25:00', endTime: '12:00', sessionDurationMinutes: 60 }]),
      ).toThrow(/Horário inválido/);
    });

    it('rejeita início posterior ou igual ao fim', () => {
      const cal = newCalendar();
      expect(() =>
        cal.setWindows([{ dayOfWeek: 1, startTime: '12:00', endTime: '09:00', sessionDurationMinutes: 60 }]),
      ).toThrow(/início deve ser anterior ao fim/);
    });

    it('rejeita sessionDurationMinutes zero ou negativo', () => {
      const cal = newCalendar();
      expect(() =>
        cal.setWindows([{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00', sessionDurationMinutes: 0 }]),
      ).toThrow(/sessionDurationMinutes deve ser positivo/);
    });

    it('rejeita sessionDurationMinutes maior que a própria janela', () => {
      const cal = newCalendar();
      expect(() =>
        cal.setWindows([{ dayOfWeek: 1, startTime: '09:00', endTime: '09:30', sessionDurationMinutes: 60 }]),
      ).toThrow(/não pode ser maior que a janela/);
    });

    it('rejeita sobreposição de janelas no mesmo dia', () => {
      const cal = newCalendar();
      expect(() =>
        cal.setWindows([
          { dayOfWeek: 1, startTime: '09:00', endTime: '12:00', sessionDurationMinutes: 60 },
          { dayOfWeek: 1, startTime: '11:00', endTime: '14:00', sessionDurationMinutes: 60 },
        ]),
      ).toThrow(/sobreposta/);
    });

    it('permite janelas no mesmo dia sem sobreposição, com durações diferentes', () => {
      const cal = newCalendar();
      cal.setWindows([
        { dayOfWeek: 1, startTime: '09:00', endTime: '12:00', sessionDurationMinutes: 60 },
        { dayOfWeek: 1, startTime: '14:00', endTime: '18:00', sessionDurationMinutes: 30 },
      ]);
      expect(cal.windows).toHaveLength(2);
    });

    it('emite AvailabilityCalendarUpdatedEvent', () => {
      const cal = newCalendar();
      cal.setWindows([{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00', sessionDurationMinutes: 60 }]);
      const events = cal.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventName).toBe('CalendarioDisponibilidadeAtualizado');
    });
  });

  describe('durationMinutesFor', () => {
    it('retorna a duração da janela do dia', () => {
      const cal = calendarWithMondayMorning(45);
      expect(cal.durationMinutesFor(new Date('2026-08-03T09:00:00'))).toBe(45);
    });

    it('retorna o default (60min) quando o dia não tem janela própria', () => {
      const cal = calendarWithMondayMorning(45);
      // 2026-08-04 é terça-feira, sem janela configurada
      expect(cal.durationMinutesFor(new Date('2026-08-04T09:00:00'))).toBe(DEFAULT_SESSION_DURATION_MINUTES);
    });
  });

  describe('isWithinWindow', () => {
    it('true quando o intervalo cabe inteiramente dentro de uma janela do mesmo dia', () => {
      const cal = calendarWithMondayMorning();
      expect(cal.isWithinWindow(new Date('2026-08-03T09:00:00'), new Date('2026-08-03T09:50:00'))).toBe(true);
    });

    it('false quando o intervalo ultrapassa o fim da janela', () => {
      const cal = calendarWithMondayMorning();
      expect(cal.isWithinWindow(new Date('2026-08-03T10:30:00'), new Date('2026-08-03T11:30:00'))).toBe(false);
    });

    it('false em um dia sem janela configurada', () => {
      const cal = calendarWithMondayMorning();
      expect(cal.isWithinWindow(new Date('2026-08-04T09:00:00'), new Date('2026-08-04T09:50:00'))).toBe(false);
    });
  });

  describe('isAvailable — o método central do Motor (ADR-0040)', () => {
    it('true dentro da janela e sem conflito com bookedSlots', () => {
      const cal = calendarWithMondayMorning();
      const result = cal.isAvailable(new Date('2026-08-03T09:00:00'), new Date('2026-08-03T09:50:00'), []);
      expect(result).toBe(true);
    });

    it('false fora da janela, mesmo sem nenhum bookedSlot', () => {
      const cal = calendarWithMondayMorning();
      const result = cal.isAvailable(new Date('2026-08-04T09:00:00'), new Date('2026-08-04T09:50:00'), []);
      expect(result).toBe(false);
    });

    it('false quando colide com um bookedSlot, mesmo dentro da janela', () => {
      const cal = calendarWithMondayMorning();
      const booked = ScheduleSlot.free('t1', new Date('2026-08-03T09:00:00'), new Date('2026-08-03T09:50:00'));
      const result = cal.isAvailable(new Date('2026-08-03T09:00:00'), new Date('2026-08-03T09:50:00'), [booked]);
      expect(result).toBe(false);
    });
  });

  describe('generateCandidateSlots', () => {
    it('gera slots de duração real da janela (50min → 09:00-11:00 = 2 slots)', () => {
      const cal = calendarWithMondayMorning(50);
      const slots = cal.generateCandidateSlots(new Date('2026-08-03T00:00:00'), new Date('2026-08-03T23:59:59'));
      expect(slots).toHaveLength(2); // 09:00-09:50 e 09:50-10:40
      expect(slots[1].startsAt.getMinutes()).toBe(50);
    });

    it('gera slots de 60min (09:00-11:00 = 2 slots, nas posições 09:00 e 10:00)', () => {
      const cal = calendarWithMondayMorning(60);
      const slots = cal.generateCandidateSlots(new Date('2026-08-03T00:00:00'), new Date('2026-08-03T23:59:59'));
      expect(slots).toHaveLength(2);
      expect(slots[1].startsAt.getMinutes()).toBe(0);
    });

    it('não gera slot algum em dia sem disponibilidade configurada', () => {
      const cal = calendarWithMondayMorning();
      const slots = cal.generateCandidateSlots(new Date('2026-08-04T00:00:00'), new Date('2026-08-04T23:59:59'));
      expect(slots).toHaveLength(0);
    });
  });

  describe('setExceptions', () => {
    it('nasce sem exceções', () => {
      expect(newCalendar().exceptions).toHaveLength(0);
    });

    it('aceita uma exceção válida', () => {
      const cal = newCalendar();
      cal.setExceptions([{ from: new Date('2026-08-03T00:00:00'), to: new Date('2026-08-10T00:00:00') }]);
      expect(cal.exceptions).toHaveLength(1);
    });

    it('substitui as exceções inteiras (não faz merge)', () => {
      const cal = newCalendar();
      cal.setExceptions([{ from: new Date('2026-08-03T00:00:00'), to: new Date('2026-08-10T00:00:00') }]);
      cal.setExceptions([{ from: new Date('2026-09-01T00:00:00'), to: new Date('2026-09-02T00:00:00') }]);
      expect(cal.exceptions).toHaveLength(1);
      expect(cal.exceptions[0].from.toISOString()).toBe(new Date('2026-09-01T00:00:00').toISOString());
    });

    it('rejeita início posterior ou igual ao fim', () => {
      const cal = newCalendar();
      expect(() =>
        cal.setExceptions([{ from: new Date('2026-08-10T00:00:00'), to: new Date('2026-08-03T00:00:00') }]),
      ).toThrow(/anterior ao fim/);
    });

    it('não valida nem depende de `reason` — aceita com, sem, ou com motivo arbitrário', () => {
      const cal = newCalendar();
      expect(() =>
        cal.setExceptions([{ from: new Date('2026-08-03T00:00:00'), to: new Date('2026-08-10T00:00:00') }]),
      ).not.toThrow();
      expect(() =>
        cal.setExceptions([
          { from: new Date('2026-08-03T00:00:00'), to: new Date('2026-08-10T00:00:00'), reason: 'ferias' },
        ]),
      ).not.toThrow();
      expect(() =>
        cal.setExceptions([
          { from: new Date('2026-08-03T00:00:00'), to: new Date('2026-08-10T00:00:00'), reason: 'qualquer coisa, até um texto que não é um tipo conhecido' },
        ]),
      ).not.toThrow();
    });

    it('emite AvailabilityCalendarUpdatedEvent', () => {
      const cal = newCalendar();
      cal.setExceptions([{ from: new Date('2026-08-03T00:00:00'), to: new Date('2026-08-10T00:00:00') }]);
      const events = cal.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventName).toBe('CalendarioDisponibilidadeAtualizado');
    });
  });

  describe('INVARIANTE — AvailabilityException tem precedência absoluta sobre AvailabilityWindow', () => {
    it('isAvailable: recusa um horário dentro da janela semanal quando cai numa exceção (dia inteiro)', () => {
      const cal = calendarWithMondayMorning(); // segunda 09:00-11:00
      cal.setExceptions([{ from: new Date('2026-08-03T00:00:00'), to: new Date('2026-08-04T00:00:00') }]); // férias no próprio dia
      const result = cal.isAvailable(new Date('2026-08-03T09:00:00'), new Date('2026-08-03T09:50:00'), []);
      expect(result).toBe(false);
    });

    it('isAvailable: recusa mesmo sem nenhum bookedSlot e mesmo totalmente dentro da janela — a janela não tem como "vencer" a exceção', () => {
      const cal = calendarWithMondayMorning();
      cal.setExceptions([{ from: new Date('2026-08-03T08:00:00'), to: new Date('2026-08-03T12:00:00') }]);
      expect(cal.isAvailable(new Date('2026-08-03T09:00:00'), new Date('2026-08-03T09:50:00'), [])).toBe(false);
    });

    it('isAvailable: libera de volta fora do intervalo da exceção, na mesma janela', () => {
      const cal = calendarWithMondayMorning(60); // segunda 09:00-11:00, 60min
      cal.setExceptions([{ from: new Date('2026-08-03T09:00:00'), to: new Date('2026-08-03T10:00:00') }]); // só 09:00-10:00 bloqueado
      expect(cal.isAvailable(new Date('2026-08-03T09:00:00'), new Date('2026-08-03T10:00:00'), [])).toBe(false);
      expect(cal.isAvailable(new Date('2026-08-03T10:00:00'), new Date('2026-08-03T11:00:00'), [])).toBe(true);
    });

    it('isAvailable: precedência não depende do `reason` declarado', () => {
      const cal = calendarWithMondayMorning();
      cal.setExceptions([
        { from: new Date('2026-08-03T00:00:00'), to: new Date('2026-08-04T00:00:00'), reason: 'bloqueio' },
      ]);
      expect(cal.isAvailable(new Date('2026-08-03T09:00:00'), new Date('2026-08-03T09:50:00'), [])).toBe(false);
    });

    it('generateCandidateSlots: nenhum slot candidato é gerado dentro do intervalo de uma exceção', () => {
      const cal = calendarWithMondayMorning(60); // segunda 09:00-11:00 → 09:00 e 10:00 seriam os 2 slots
      cal.setExceptions([{ from: new Date('2026-08-03T09:00:00'), to: new Date('2026-08-03T10:00:00') }]);
      const slots = cal.generateCandidateSlots(new Date('2026-08-03T00:00:00'), new Date('2026-08-03T23:59:59'));
      expect(slots).toHaveLength(1);
      expect(slots[0].startsAt.getHours()).toBe(10);
    });
  });
});
