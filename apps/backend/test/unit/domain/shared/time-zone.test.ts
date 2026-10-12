import { describe, it, expect } from 'vitest';
import {
  addCivilDays,
  assertTimeZone,
  civilDateIn,
  civilDateOfDateOnly,
  civilDayNumber,
  dayOfWeekOf,
  DEFAULT_CLINIC_TIME_ZONE,
  formatCivilDate,
  instantAt,
  isSameLocalDay,
  isIanaTimeZoneName,
  isValidTimeZone,
  localDateTime,
  localDayRange,
  startOfLocalDay,
} from '@domain/shared/time-zone';

/**
 * AD-039 (ADR-0064) — dia e hora no fuso da clínica.
 *
 * Todos os instantes daqui são escritos em UTC (`…Z`) ou com o deslocamento
 * explícito, para o teste dizer o mesmo com o processo em qualquer fuso —
 * que é justamente o que a regra exige.
 */
const SAO_PAULO = 'America/Sao_Paulo';

describe('fuso padrão e validação', () => {
  it('o padrão das clínicas é America/Sao_Paulo', () => {
    expect(DEFAULT_CLINIC_TIME_ZONE).toBe('America/Sao_Paulo');
  });

  it('reconhece nomes da base IANA e recusa o resto', () => {
    for (const valid of ['America/Sao_Paulo', 'America/Manaus', 'America/Rio_Branco', 'America/Noronha', 'UTC', 'Europe/Lisbon', 'Asia/Tokyo']) {
      expect(isValidTimeZone(valid), valid).toBe(true);
    }
    for (const invalid of ['', '   ', 'Brasilia', 'America/Sao Paulo', 'GMT-3h', 'Marte/Olimpo', null, undefined, 3, {}]) {
      expect(isValidTimeZone(invalid), String(invalid)).toBe(false);
    }
  });

  it('assertTimeZone devolve o fuso válido e lança, com o valor recebido, para o inválido — nunca troca por outro', () => {
    expect(assertTimeZone('America/Manaus')).toBe('America/Manaus');
    expect(() => assertTimeZone('Brasilia')).toThrow(/Fuso horário inválido: "Brasilia"/);
    expect(() => assertTimeZone(undefined)).toThrow(/Fuso horário inválido/);
  });

  it('isIanaTimeZoneName — para GRAVAR, só o nome exato de uma zona da base IANA', () => {
    for (const valid of ['America/Sao_Paulo', 'America/Manaus', 'America/Rio_Branco', 'America/Noronha', 'Europe/Lisbon', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
      expect(isIanaTimeZoneName(valid), valid).toBe(true);
    }
    // O `Intl` calcula com vários destes (por isso `isValidTimeZone` os aceita, onde existem); nenhum é o nome de uma zona.
    for (const loose of ['america/sao_paulo', 'AMERICA/SAO_PAULO', 'UTC', 'GMT', 'Etc/UTC', '+03:00', '-03:00', ' America/Sao_Paulo', 'America/Sao_Paulo ']) {
      expect(isIanaTimeZoneName(loose), loose).toBe(false);
    }
    for (const invalid of ['', '   ', 'Brasilia', 'America/Sao Paulo', 'Marte/Olimpo', null, undefined, 3, {}, ['America/Sao_Paulo']]) {
      expect(isIanaTimeZoneName(invalid), String(invalid)).toBe(false);
    }
  });

  it('todo nome que pode ser gravado é um fuso com que o sistema sabe calcular', () => {
    for (const zone of Intl.supportedValuesOf('timeZone')) {
      expect(isIanaTimeZoneName(zone), zone).toBe(true);
      expect(isValidTimeZone(zone), zone).toBe(true);
    }
  });
});

describe('localDateTime — que dia e que hora é um instante, em cada fuso', () => {
  it('São Paulo está 3 h atrás do UTC', () => {
    expect(localDateTime(new Date('2026-10-12T12:00:00Z'), SAO_PAULO)).toEqual({
      year: 2026, month: 10, day: 12, hour: 9, minute: 0, second: 0, dayOfWeek: 1,
    });
  });

  it('antes da meia-noite de lá ainda é o dia anterior, mesmo já sendo o dia seguinte em UTC', () => {
    const instant = new Date('2026-10-13T02:59:59Z');
    expect(localDateTime(instant, SAO_PAULO)).toMatchObject({ year: 2026, month: 10, day: 12, hour: 23, minute: 59, second: 59, dayOfWeek: 1 });
    expect(localDateTime(instant, 'UTC')).toMatchObject({ day: 13, hour: 2, dayOfWeek: 2 });
  });

  it('meia-noite é hora 0, nunca 24', () => {
    expect(localDateTime(new Date('2026-10-13T03:00:00Z'), SAO_PAULO)).toMatchObject({ day: 13, hour: 0, minute: 0 });
  });

  it('o mesmo instante em fusos diferentes', () => {
    const instant = new Date('2026-12-31T23:30:00Z');
    expect(civilDateIn(instant, SAO_PAULO)).toEqual({ year: 2026, month: 12, day: 31 });
    expect(civilDateIn(instant, 'America/Manaus')).toEqual({ year: 2026, month: 12, day: 31 });
    expect(civilDateIn(instant, 'Asia/Tokyo')).toEqual({ year: 2027, month: 1, day: 1 });
    expect(localDateTime(instant, 'Asia/Kolkata')).toMatchObject({ year: 2027, month: 1, day: 1, hour: 5, minute: 0 });
  });
});

describe('instantAt — o instante em que o relógio da clínica marca uma data e hora', () => {
  it('09:00 em São Paulo é 12:00 UTC', () => {
    expect(instantAt(SAO_PAULO, { year: 2026, month: 10, day: 12 }, { hour: 9 }).toISOString()).toBe('2026-10-12T12:00:00.000Z');
  });

  it('sem hora, é a meia-noite que abre o dia', () => {
    expect(instantAt(SAO_PAULO, { year: 2026, month: 10, day: 12 }).toISOString()).toBe('2026-10-12T03:00:00.000Z');
    expect(instantAt('Asia/Tokyo', { year: 2026, month: 10, day: 12 }).toISOString()).toBe('2026-10-11T15:00:00.000Z');
    expect(instantAt('UTC', { year: 2026, month: 10, day: 12 }).toISOString()).toBe('2026-10-12T00:00:00.000Z');
  });

  it('fusos do Brasil: a mesma hora de parede, instantes diferentes', () => {
    const nineAt = (timeZone: string) => instantAt(timeZone, { year: 2026, month: 3, day: 2 }, { hour: 9 }).toISOString();
    expect(nineAt('America/Noronha')).toBe('2026-03-02T11:00:00.000Z');
    expect(nineAt('America/Sao_Paulo')).toBe('2026-03-02T12:00:00.000Z');
    expect(nineAt('America/Manaus')).toBe('2026-03-02T13:00:00.000Z');
    expect(nineAt('America/Rio_Branco')).toBe('2026-03-02T14:00:00.000Z');
  });

  it('é o inverso de localDateTime', () => {
    for (const timeZone of [SAO_PAULO, 'America/Manaus', 'UTC', 'Asia/Tokyo', 'Asia/Kolkata', 'America/New_York', 'Europe/Lisbon']) {
      for (const iso of ['2026-01-01T00:00:00Z', '2026-06-15T13:45:30Z', '2026-10-13T02:59:59Z', '2026-12-31T23:59:59Z']) {
        const instant = new Date(iso);
        const local = localDateTime(instant, timeZone);
        expect(instantAt(timeZone, local, local).toISOString(), `${timeZone} ${iso}`).toBe(instant.toISOString());
      }
    }
  });

  it('São Paulo teve horário de verão até 2019: a regra de cada ano é a daquele ano', () => {
    // Em janeiro de 2018 valia o horário de verão (UTC-2); em janeiro de 2026, não (UTC-3).
    expect(instantAt(SAO_PAULO, { year: 2018, month: 1, day: 15 }, { hour: 9 }).toISOString()).toBe('2018-01-15T11:00:00.000Z');
    expect(instantAt(SAO_PAULO, { year: 2026, month: 1, day: 15 }, { hour: 9 }).toISOString()).toBe('2026-01-15T12:00:00.000Z');
  });

  it('hora que não existe (o relógio pulou): vale o instante equivalente depois do salto', () => {
    // Nova York, 08/03/2026: às 02:00 o relógio vai direto para as 03:00.
    const day = { year: 2026, month: 3, day: 8 };
    expect(instantAt('America/New_York', day, { hour: 1, minute: 30 }).toISOString()).toBe('2026-03-08T06:30:00.000Z');
    expect(instantAt('America/New_York', day, { hour: 2, minute: 30 }).toISOString()).toBe('2026-03-08T07:30:00.000Z'); // 03:30 de lá
    expect(instantAt('America/New_York', day, { hour: 3, minute: 30 }).toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('hora que existe duas vezes (o relógio voltou): vale a primeira', () => {
    // Nova York, 01/11/2026: às 02:00 o relógio volta para a 01:00.
    const day = { year: 2026, month: 11, day: 1 };
    expect(instantAt('America/New_York', day, { hour: 1, minute: 30 }).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(instantAt('America/New_York', day, { hour: 2, minute: 30 }).toISOString()).toBe('2026-11-01T07:30:00.000Z');
  });
});

describe('dias do calendário', () => {
  it('startOfLocalDay: a meia-noite da clínica que abre o dia daquele instante', () => {
    expect(startOfLocalDay(new Date('2026-10-13T02:59:59Z'), SAO_PAULO).toISOString()).toBe('2026-10-12T03:00:00.000Z');
    expect(startOfLocalDay(new Date('2026-10-13T03:00:00Z'), SAO_PAULO).toISOString()).toBe('2026-10-13T03:00:00.000Z');
  });

  it('localDayRange: do primeiro ao último milissegundo do dia', () => {
    const { from, to } = localDayRange(SAO_PAULO, { year: 2026, month: 10, day: 12 });
    expect(from.toISOString()).toBe('2026-10-12T03:00:00.000Z');
    expect(to.toISOString()).toBe('2026-10-13T02:59:59.999Z');
  });

  it('localDayRange em dia de mudança de horário: o dia tem 23 ou 25 horas', () => {
    const hours = (range: { from: Date; to: Date }) => (range.to.getTime() + 1 - range.from.getTime()) / 3_600_000;
    expect(hours(localDayRange('America/New_York', { year: 2026, month: 3, day: 8 }))).toBe(23);
    expect(hours(localDayRange('America/New_York', { year: 2026, month: 11, day: 1 }))).toBe(25);
    expect(hours(localDayRange(SAO_PAULO, { year: 2026, month: 3, day: 8 }))).toBe(24);
  });

  it('isSameLocalDay compara pelo dia da clínica', () => {
    const lateSunday = new Date('2026-10-12T02:30:00Z'); // 23:30 de domingo, 11/10, em São Paulo
    const earlyMonday = new Date('2026-10-12T03:30:00Z'); // 00:30 de segunda, 12/10
    expect(isSameLocalDay(lateSunday, earlyMonday, SAO_PAULO)).toBe(false);
    expect(isSameLocalDay(lateSunday, earlyMonday, 'UTC')).toBe(true);
  });

  it('addCivilDays atravessa mês, ano e 29 de fevereiro', () => {
    expect(addCivilDays({ year: 2026, month: 1, day: 31 }, 1)).toEqual({ year: 2026, month: 2, day: 1 });
    expect(addCivilDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(addCivilDays({ year: 2028, month: 2, day: 28 }, 1)).toEqual({ year: 2028, month: 2, day: 29 });
    expect(addCivilDays({ year: 2026, month: 3, day: 1 }, -1)).toEqual({ year: 2026, month: 2, day: 28 });
    expect(addCivilDays({ year: 2026, month: 10, day: 12 }, 40)).toEqual({ year: 2026, month: 11, day: 21 });
  });

  it('civilDayNumber cresce um por dia, inclusive nas viradas', () => {
    expect(civilDayNumber({ year: 2026, month: 3, day: 1 }) - civilDayNumber({ year: 2026, month: 2, day: 28 })).toBe(1);
    expect(civilDayNumber({ year: 2027, month: 1, day: 1 }) - civilDayNumber({ year: 2026, month: 1, day: 1 })).toBe(365);
    expect(civilDayNumber({ year: 2029, month: 1, day: 1 }) - civilDayNumber({ year: 2028, month: 1, day: 1 })).toBe(366);
  });

  it('dayOfWeekOf e formatCivilDate', () => {
    expect(dayOfWeekOf({ year: 2026, month: 10, day: 11 })).toBe(0); // domingo
    expect(dayOfWeekOf({ year: 2026, month: 10, day: 12 })).toBe(1); // segunda-feira
    expect(dayOfWeekOf({ year: 2026, month: 10, day: 17 })).toBe(6); // sábado
    expect(formatCivilDate({ year: 2026, month: 3, day: 7 })).toBe('2026-03-07');
  });

  it('civilDateOfDateOnly lê a data em UTC, que é como a API grava uma data sem hora', () => {
    expect(civilDateOfDateOnly(new Date('2026-08-10'))).toEqual({ year: 2026, month: 8, day: 10 });
    expect(civilDateOfDateOnly(new Date('2026-08-10T00:00:00Z'))).toEqual({ year: 2026, month: 8, day: 10 });
    expect(civilDateOfDateOnly(new Date('2026-08-10T23:59:59Z'))).toEqual({ year: 2026, month: 8, day: 10 });
  });
});

describe('nada depende do fuso do processo', () => {
  it('as respostas são as mesmas com o processo em UTC (o contêiner), em Brasília ou do outro lado do mundo', () => {
    const original = process.env.TZ;
    const answers = new Set<string>();
    try {
      for (const processTimeZone of ['UTC', 'America/Sao_Paulo', 'Asia/Tokyo', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
        process.env.TZ = processTimeZone;
        answers.add(
          JSON.stringify([
            localDateTime(new Date('2026-10-13T02:59:59Z'), SAO_PAULO),
            instantAt(SAO_PAULO, { year: 2026, month: 10, day: 12 }, { hour: 9 }).toISOString(),
            startOfLocalDay(new Date('2026-10-13T02:59:59Z'), SAO_PAULO).toISOString(),
            civilDateOfDateOnly(new Date('2026-08-10T00:00:00Z')),
            dayOfWeekOf({ year: 2026, month: 10, day: 12 }),
          ]),
        );
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    expect(answers.size).toBe(1);
    expect([...answers][0]).toContain('"2026-10-12T12:00:00.000Z"');
  });
});
