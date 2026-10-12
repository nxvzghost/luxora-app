import { describe, it, expect } from 'vitest';
import { AvailabilityCalendar, type AvailabilityWindow } from '@domain/availability/availability-calendar.entity';

/**
 * AD-039 (ADR-0064) — as janelas de disponibilidade valem no fuso da clínica.
 *
 * Antes, "09:00" era lido no fuso do processo: no contêiner, em UTC, a
 * janela de uma clínica de São Paulo abria às 06:00 de lá. Todos os
 * instantes aqui são escritos em UTC, para o teste dizer o mesmo com o
 * processo em qualquer fuso.
 *
 * 2026-08-03 é uma segunda-feira; 2026-08-02, um domingo.
 */
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const MONDAY_MORNING: AvailabilityWindow = { dayOfWeek: 1, startTime: '09:00', endTime: '11:00', sessionDurationMinutes: 60 };

function calendarIn(timeZone: string, windows: AvailabilityWindow[] = [MONDAY_MORNING]) {
  const calendar = AvailabilityCalendar.create({ id: 'cal1', tenantId: TENANT_ID, therapistId: 't1', timeZone });
  calendar.setWindows(windows);
  return calendar;
}

const starts = (calendar: AvailabilityCalendar, from: string, to: string) =>
  calendar.generateCandidateSlots(new Date(from), new Date(to)).map((slot) => slot.startsAt.toISOString());

describe('AvailabilityCalendar — janelas no fuso da clínica', () => {
  it('guarda o fuso com que foi criado', () => {
    expect(calendarIn('America/Manaus').timeZone).toBe('America/Manaus');
  });

  it('clínica em São Paulo: a janela "09:00" abre às 09:00 de lá (12:00 UTC), não às 09:00 UTC', () => {
    const calendar = calendarIn('America/Sao_Paulo');

    expect(calendar.isAvailable(new Date('2026-08-03T12:00:00Z'), new Date('2026-08-03T13:00:00Z'), [])).toBe(true);
    // 09:00 UTC é 06:00 em São Paulo — o horário que o contêiner em UTC oferecia antes.
    expect(calendar.isAvailable(new Date('2026-08-03T09:00:00Z'), new Date('2026-08-03T10:00:00Z'), [])).toBe(false);
    expect(starts(calendar, '2026-08-03T03:00:00Z', '2026-08-04T02:59:59Z')).toEqual(['2026-08-03T12:00:00.000Z', '2026-08-03T13:00:00.000Z']);
  });

  it('a janela fecha na hora de lá: o último horário termina às 11:00 de São Paulo', () => {
    const calendar = calendarIn('America/Sao_Paulo');

    expect(calendar.isWithinWindow(new Date('2026-08-03T13:00:00Z'), new Date('2026-08-03T14:00:00Z'))).toBe(true); // 10:00–11:00
    expect(calendar.isWithinWindow(new Date('2026-08-03T13:30:00Z'), new Date('2026-08-03T14:30:00Z'))).toBe(false); // 10:30–11:30
    expect(calendar.isWithinWindow(new Date('2026-08-03T11:59:00Z'), new Date('2026-08-03T12:59:00Z'))).toBe(false); // 08:59–09:59
  });

  it('a mesma janela em clínicas de fusos diferentes: cada uma na sua hora, sem afetar a outra', () => {
    const range = ['2026-08-02T00:00:00Z', '2026-08-05T00:00:00Z'] as const;

    expect(starts(calendarIn('America/Noronha'), ...range)).toEqual(['2026-08-03T11:00:00.000Z', '2026-08-03T12:00:00.000Z']);
    expect(starts(calendarIn('America/Sao_Paulo'), ...range)).toEqual(['2026-08-03T12:00:00.000Z', '2026-08-03T13:00:00.000Z']);
    expect(starts(calendarIn('America/Manaus'), ...range)).toEqual(['2026-08-03T13:00:00.000Z', '2026-08-03T14:00:00.000Z']);
    expect(starts(calendarIn('America/Rio_Branco'), ...range)).toEqual(['2026-08-03T14:00:00.000Z', '2026-08-03T15:00:00.000Z']);
    // Tóquio está 9 h à frente: segunda 09:00 de lá é segunda 00:00 UTC.
    expect(starts(calendarIn('Asia/Tokyo'), ...range)).toEqual(['2026-08-03T00:00:00.000Z', '2026-08-03T01:00:00.000Z']);
  });

  it('um horário que serve a uma clínica não serve à outra', () => {
    const noon = [new Date('2026-08-03T12:00:00Z'), new Date('2026-08-03T13:00:00Z')] as const;

    expect(calendarIn('America/Sao_Paulo').isAvailable(...noon, [])).toBe(true); // 09:00 em São Paulo
    expect(calendarIn('America/Manaus').isAvailable(...noon, [])).toBe(false); // 08:00 em Manaus
  });

  it('o dia da semana é o da clínica: 21:30 de domingo em São Paulo já é segunda-feira em UTC', () => {
    const sundayNight: AvailabilityWindow = { dayOfWeek: 0, startTime: '21:00', endTime: '23:00', sessionDurationMinutes: 60 };
    const from = new Date('2026-08-03T00:30:00Z'); // domingo 21:30 em São Paulo; segunda 00:30 em UTC
    const to = new Date('2026-08-03T01:30:00Z');

    expect(calendarIn('America/Sao_Paulo', [sundayNight]).isWithinWindow(from, to)).toBe(true);
    expect(calendarIn('America/Sao_Paulo', [{ ...sundayNight, dayOfWeek: 1 }]).isWithinWindow(from, to)).toBe(false);
    expect(calendarIn('America/Sao_Paulo', [sundayNight]).durationMinutesFor(from)).toBe(60);
    // Sem janela na segunda-feira, um instante que só é segunda em UTC não ganha a duração da janela de domingo "por engano".
    expect(calendarIn('UTC', [sundayNight]).isWithinWindow(from, to)).toBe(false);
  });

  it('"mesmo dia" é o da clínica: cruzar a meia-noite UTC é permitido, cruzar a meia-noite de lá não', () => {
    const allDay: AvailabilityWindow[] = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startTime: '00:00', endTime: '23:59', sessionDurationMinutes: 60 }));
    const calendar = calendarIn('America/Sao_Paulo', allDay);

    // 20:30–21:30 de segunda em São Paulo: 23:30Z de segunda a 00:30Z de terça.
    expect(calendar.isWithinWindow(new Date('2026-08-03T23:30:00Z'), new Date('2026-08-04T00:30:00Z'))).toBe(true);
    // 23:30 de segunda a 00:30 de terça em São Paulo: no mesmo dia em UTC, em dias diferentes na clínica.
    expect(calendar.isWithinWindow(new Date('2026-08-04T02:30:00Z'), new Date('2026-08-04T03:30:00Z'))).toBe(false);
  });

  it('o intervalo pedido é percorrido pelos dias da clínica, sem dia a mais nem a menos', () => {
    const weekdays: AvailabilityWindow[] = [1, 2].map((dayOfWeek) => ({ dayOfWeek, startTime: '09:00', endTime: '10:00', sessionDurationMinutes: 60 }));
    const calendar = calendarIn('America/Sao_Paulo', weekdays);

    // Da segunda 00:00 à terça 23:59 de São Paulo: um horário em cada dia.
    expect(starts(calendar, '2026-08-03T03:00:00Z', '2026-08-05T02:59:59Z')).toEqual(['2026-08-03T12:00:00.000Z', '2026-08-04T12:00:00.000Z']);
    // Começando no domingo às 22:00 de lá (já segunda em UTC): nada de domingo, e a segunda aparece uma vez só.
    expect(starts(calendar, '2026-08-03T01:00:00Z', '2026-08-04T02:59:59Z')).toEqual(['2026-08-03T12:00:00.000Z']);
    // Terminando na segunda às 22:00 de lá (já terça em UTC): a terça não entra.
    expect(starts(calendar, '2026-08-03T03:00:00Z', '2026-08-04T01:00:00Z')).toEqual(['2026-08-03T12:00:00.000Z']);
  });

  it('intervalo que cabe em um só dia da clínica e, em UTC, cai inteiro em outro dia: vale a janela do dia da clínica', () => {
    // Domingo, das 21:00 às 23:00 em São Paulo — em UTC, segunda-feira da 00:00 às 02:00.
    const sundayNight: AvailabilityWindow = { dayOfWeek: 0, startTime: '21:00', endTime: '23:00', sessionDurationMinutes: 60 };
    expect(starts(calendarIn('America/Sao_Paulo', [sundayNight]), '2026-08-03T00:00:00Z', '2026-08-03T02:00:00Z')).toEqual([
      '2026-08-03T00:00:00.000Z',
      '2026-08-03T01:00:00.000Z',
    ]);

    // Segunda-feira, da 00:00 às 02:00 em Tóquio — em UTC, domingo das 15:00 às 17:00.
    const mondayEarly: AvailabilityWindow = { dayOfWeek: 1, startTime: '00:00', endTime: '02:00', sessionDurationMinutes: 60 };
    expect(starts(calendarIn('Asia/Tokyo', [mondayEarly]), '2026-08-02T15:00:00Z', '2026-08-02T17:00:00Z')).toEqual([
      '2026-08-02T15:00:00.000Z',
      '2026-08-02T16:00:00.000Z',
    ]);
  });

  it('o resultado não depende do fuso do processo — contêiner em UTC, máquina em Brasília ou qualquer outro', () => {
    const original = process.env.TZ;
    const answers = new Set<string>();
    try {
      for (const processTimeZone of ['UTC', 'America/Sao_Paulo', 'Asia/Tokyo', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
        process.env.TZ = processTimeZone;
        const calendar = calendarIn('America/Sao_Paulo');
        answers.add(
          JSON.stringify([
            starts(calendar, '2026-08-02T00:00:00Z', '2026-08-05T00:00:00Z'),
            calendar.isAvailable(new Date('2026-08-03T12:00:00Z'), new Date('2026-08-03T13:00:00Z'), []),
            calendar.isAvailable(new Date('2026-08-03T09:00:00Z'), new Date('2026-08-03T10:00:00Z'), []),
            calendar.durationMinutesFor(new Date('2026-08-03T00:30:00Z')),
          ]),
        );
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    expect([...answers]).toEqual([JSON.stringify([['2026-08-03T12:00:00.000Z', '2026-08-03T13:00:00.000Z'], true, false, 60])]);
  });

  it('fuso com horário de verão: a janela acompanha a hora de parede antes e depois da mudança', () => {
    const sundayMorning: AvailabilityWindow = { dayOfWeek: 0, startTime: '09:00', endTime: '11:00', sessionDurationMinutes: 60 };
    const calendar = calendarIn('America/New_York', [sundayMorning]);

    // 01/03/2026, horário padrão (UTC-5): 09:00 de lá é 14:00 UTC.
    expect(starts(calendar, '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z')).toEqual(['2026-03-01T14:00:00.000Z', '2026-03-01T15:00:00.000Z']);
    // 08/03/2026, o dia em que o horário de verão começa (UTC-4): 09:00 de lá é 13:00 UTC.
    expect(starts(calendar, '2026-03-08T00:00:00Z', '2026-03-09T00:00:00Z')).toEqual(['2026-03-08T13:00:00.000Z', '2026-03-08T14:00:00.000Z']);
  });

  it('exceção e horário ocupado continuam valendo sobre a janela, que agora está no fuso certo', () => {
    const calendar = calendarIn('America/Sao_Paulo');
    calendar.setExceptions([{ from: new Date('2026-08-03T12:00:00Z'), to: new Date('2026-08-03T13:00:00Z') }]); // 09:00–10:00 de lá

    expect(calendar.isAvailable(new Date('2026-08-03T12:00:00Z'), new Date('2026-08-03T13:00:00Z'), [])).toBe(false);
    expect(calendar.isAvailable(new Date('2026-08-03T13:00:00Z'), new Date('2026-08-03T14:00:00Z'), [])).toBe(true);
    expect(starts(calendar, '2026-08-03T03:00:00Z', '2026-08-04T02:59:59Z')).toEqual(['2026-08-03T13:00:00.000Z']);
  });
});
