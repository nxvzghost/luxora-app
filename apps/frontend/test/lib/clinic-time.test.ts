import { describe, it, expect } from 'vitest';
import {
  BRAZIL_TIME_ZONES,
  addDays,
  civilDateIn,
  dayRange,
  formatDay,
  formatInZone,
  instantAt,
  instantFromLocalInput,
  isKnownTimeZone,
  otherTimeZones,
  parseDay,
  startOfDayIn,
  todayInputValue,
} from '@/lib/clinic-time';

/**
 * AD-039 (ADR-0064) — dia e hora no fuso da clínica, no painel.
 *
 * Todos os instantes são escritos em UTC e todo fuso é dito no teste: o
 * resultado é o mesmo seja qual for o fuso da máquina que roda a suíte —
 * que é a regra. Os casos repetem os do backend
 * (apps/backend/test/unit/domain/shared/time-zone.test.ts): as duas pontas
 * têm de concordar sobre que dia e que hora é um instante na clínica.
 */
const SAO_PAULO = 'America/Sao_Paulo';
const MANAUS = 'America/Manaus';
const TOKYO = 'Asia/Tokyo';
const NEW_YORK = 'America/New_York';

describe('civilDateIn — em que dia cai um instante', () => {
  // 22:30 de segunda, 12/10/2026, em São Paulo — em UTC já é terça, 13/10, 01:30.
  const LATE_EVENING = new Date('2026-10-13T01:30:00Z');

  it('às 22:30 de São Paulo ainda é dia 12 lá; em Tóquio já é dia 13', () => {
    expect(civilDateIn(LATE_EVENING, SAO_PAULO)).toEqual({ year: 2026, month: 10, day: 12 });
    expect(civilDateIn(LATE_EVENING, MANAUS)).toEqual({ year: 2026, month: 10, day: 12 });
    expect(civilDateIn(LATE_EVENING, TOKYO)).toEqual({ year: 2026, month: 10, day: 13 });
  });

  it('a virada é à meia-noite do fuso', () => {
    expect(civilDateIn(new Date('2026-10-13T02:59:59Z'), SAO_PAULO).day).toBe(12);
    expect(civilDateIn(new Date('2026-10-13T03:00:00Z'), SAO_PAULO).day).toBe(13);
    expect(civilDateIn(new Date('2026-10-13T03:59:59Z'), MANAUS).day).toBe(12);
    expect(civilDateIn(new Date('2026-10-13T04:00:00Z'), MANAUS).day).toBe(13);
  });

  it('todayInputValue é o dia da clínica, no formato do campo de data', () => {
    expect(todayInputValue(LATE_EVENING, SAO_PAULO)).toBe('2026-10-12');
    expect(todayInputValue(LATE_EVENING, TOKYO)).toBe('2026-10-13');
    expect(todayInputValue(new Date('2027-01-01T02:00:00Z'), SAO_PAULO)).toBe('2026-12-31');
  });
});

describe('instantAt — o instante em que o relógio da clínica marca uma data e hora', () => {
  it('09:00 em São Paulo é 12:00 UTC; em Manaus, 13:00 UTC; em Tóquio, 00:00 UTC', () => {
    const day = { year: 2026, month: 10, day: 14 };
    expect(instantAt(SAO_PAULO, day, { hour: 9 }).toISOString()).toBe('2026-10-14T12:00:00.000Z');
    expect(instantAt(MANAUS, day, { hour: 9 }).toISOString()).toBe('2026-10-14T13:00:00.000Z');
    expect(instantAt(TOKYO, day, { hour: 9 }).toISOString()).toBe('2026-10-14T00:00:00.000Z');
  });

  it('usa a regra do ano: São Paulo tinha horário de verão em 2018 (UTC-2) e não tem em 2026 (UTC-3)', () => {
    expect(instantAt(SAO_PAULO, { year: 2018, month: 12, day: 10 }, { hour: 9 }).toISOString()).toBe('2018-12-10T11:00:00.000Z');
    expect(instantAt(SAO_PAULO, { year: 2026, month: 12, day: 10 }, { hour: 9 }).toISOString()).toBe('2026-12-10T12:00:00.000Z');
  });

  it('hora que não existe (o relógio pulou por cima): vale o instante equivalente depois do salto', () => {
    // Nova York, 8/3/2026: das 02:00 o relógio vai direto para as 03:00.
    expect(instantAt(NEW_YORK, { year: 2026, month: 3, day: 8 }, { hour: 2, minute: 30 }).toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('hora que existe duas vezes (o relógio voltou): vale a primeira', () => {
    // Nova York, 1/11/2026: 01:30 acontece em UTC-4 e de novo em UTC-5.
    expect(instantAt(NEW_YORK, { year: 2026, month: 11, day: 1 }, { hour: 1, minute: 30 }).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('ida e volta: o dia do instante devolvido é o dia pedido, em cada fuso', () => {
    for (const zone of [SAO_PAULO, MANAUS, TOKYO, NEW_YORK, 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Noronha']) {
      for (const day of [{ year: 2026, month: 1, day: 1 }, { year: 2026, month: 3, day: 8 }, { year: 2026, month: 11, day: 1 }, { year: 2028, month: 2, day: 29 }]) {
        expect(civilDateIn(instantAt(zone, day), zone), `${zone} ${formatDay(day)}`).toEqual(day);
      }
    }
  });
});

describe('dayRange e startOfDayIn — o dia inteiro da clínica', () => {
  it('o dia 14/10 em São Paulo vai das 03:00 UTC do dia 14 às 03:00 UTC do dia 15', () => {
    const range = dayRange('2026-10-14', SAO_PAULO);
    expect(range?.from.toISOString()).toBe('2026-10-14T03:00:00.000Z');
    expect(range?.to.toISOString()).toBe('2026-10-15T03:00:00.000Z');
  });

  it('o mesmo dia do calendário é outro intervalo de tempo em outro fuso', () => {
    expect(dayRange('2026-10-14', MANAUS)?.from.toISOString()).toBe('2026-10-14T04:00:00.000Z');
    expect(dayRange('2026-10-14', TOKYO)?.from.toISOString()).toBe('2026-10-13T15:00:00.000Z');
    expect(dayRange('2026-10-14', 'Pacific/Kiritimati')?.from.toISOString()).toBe('2026-10-13T10:00:00.000Z');
  });

  it('dia com mudança de horário de verão tem 23 ou 25 horas, e o intervalo acompanha', () => {
    const hours = (day: string) => {
      const range = dayRange(day, NEW_YORK)!;
      return (range.to.getTime() - range.from.getTime()) / 3_600_000;
    };
    expect(hours('2026-03-08')).toBe(23);
    expect(hours('2026-11-01')).toBe(25);
    expect(hours('2026-06-10')).toBe(24);
  });

  it('recusa o que não é uma data do calendário', () => {
    for (const invalid of ['', '2026-10', '14/10/2026', '2026-13-01', '2026-02-30', '2026-10-14T09:00', 'hoje']) {
      expect(dayRange(invalid, SAO_PAULO), invalid).toBeNull();
      expect(parseDay(invalid), invalid).toBeNull();
    }
    expect(parseDay('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 });
  });

  it('startOfDayIn: a meia-noite da clínica de hoje, e de daqui a sete dias do calendário', () => {
    const now = new Date('2026-10-13T01:30:00Z'); // 22:30 do dia 12 em São Paulo
    expect(startOfDayIn(SAO_PAULO, 0, now).toISOString()).toBe('2026-10-12T03:00:00.000Z');
    expect(startOfDayIn(SAO_PAULO, 7, now).toISOString()).toBe('2026-10-19T03:00:00.000Z');
    expect(startOfDayIn(SAO_PAULO, -7, now).toISOString()).toBe('2026-10-05T03:00:00.000Z');
    expect(startOfDayIn(TOKYO, 0, now).toISOString()).toBe('2026-10-12T15:00:00.000Z');
  });

  it('addDays anda pelo calendário, atravessando mês e ano', () => {
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(addDays({ year: 2026, month: 3, day: 1 }, -1)).toEqual({ year: 2026, month: 2, day: 28 });
  });
});

describe('instantFromLocalInput — o que a pessoa digita é hora de parede da clínica', () => {
  it('"2031-03-10T08:00" é 11:00 UTC para São Paulo e 12:00 UTC para Manaus', () => {
    expect(instantFromLocalInput('2031-03-10T08:00', SAO_PAULO)?.toISOString()).toBe('2031-03-10T11:00:00.000Z');
    expect(instantFromLocalInput('2031-03-10T08:00', MANAUS)?.toISOString()).toBe('2031-03-10T12:00:00.000Z');
    expect(instantFromLocalInput('2031-03-10T08:00:30', TOKYO)?.toISOString()).toBe('2031-03-09T23:00:30.000Z');
  });

  it('valor vazio ou malformado: null', () => {
    for (const invalid of ['', '2031-03-10', '10/03/2031 08:00', '2031-03-10T25:00', '2031-03-10T08:61', '2031-02-30T08:00']) {
      expect(instantFromLocalInput(invalid, SAO_PAULO), invalid).toBeNull();
    }
  });
});

describe('formatInZone — a hora mostrada é a da clínica', () => {
  const instant = '2026-10-13T12:00:00.000Z';
  const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };

  it('12:00 UTC aparece como 09:00 em São Paulo, 08:00 em Manaus e 21:00 em Tóquio', () => {
    expect(formatInZone(instant, time, SAO_PAULO)).toBe('09:00');
    expect(formatInZone(instant, time, MANAUS)).toBe('08:00');
    expect(formatInZone(instant, time, TOKYO)).toBe('21:00');
  });

  it('o dia mostrado também é o da clínica', () => {
    const date: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric' };
    expect(formatInZone('2026-10-13T01:30:00.000Z', date, SAO_PAULO)).toBe('12/10/2026');
    expect(formatInZone('2026-10-13T01:30:00.000Z', date, TOKYO)).toBe('13/10/2026');
  });
});

describe('fusos oferecidos em Configurações', () => {
  it('todo fuso do Brasil oferecido é o nome exato de uma zona IANA — o que a API aceita gravar', () => {
    const iana = new Set(Intl.supportedValuesOf('timeZone'));
    for (const zone of BRAZIL_TIME_ZONES) {
      expect(iana.has(zone.value), zone.value).toBe(true);
      expect(isKnownTimeZone(zone.value), zone.value).toBe(true);
    }
    expect(BRAZIL_TIME_ZONES[0].value).toBe(SAO_PAULO);
    expect(new Set(BRAZIL_TIME_ZONES.map((zone) => zone.value)).size).toBe(BRAZIL_TIME_ZONES.length);
  });

  it('os demais fusos não repetem os do Brasil', () => {
    const others = otherTimeZones();
    expect(others).toContain('Europe/Lisbon');
    expect(others).not.toContain(SAO_PAULO);
    expect(others).not.toContain(MANAUS);
  });

  it('isKnownTimeZone recusa o que o navegador não conhece, sem lançar', () => {
    for (const invalid of ['', 'Brasilia', 'Marte/Olimpo', undefined, null, 3]) {
      expect(isKnownTimeZone(invalid), String(invalid)).toBe(false);
    }
  });
});
