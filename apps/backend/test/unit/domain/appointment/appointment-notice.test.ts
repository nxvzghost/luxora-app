import { describe, it, expect } from 'vitest';
import { Appointment } from '@domain/appointment/appointment.entity';
import { AppointmentNotice, classifyNoticeTiming } from '@domain/appointment/appointment-notice';

/**
 * K2-b (ADR-0069, seções 2.2 e 2.3) — classificação do momento da
 * comunicação e registro pelo painel. Fronteiras exatas: limite de 2 h e de
 * 4 h, sem limite, 1 ms antes do início, no instante do início, depois e
 * horas depois do fim do horário.
 */
const START = new Date('2026-08-10T15:00:00Z');
const before = (ms: number) => new Date(START.getTime() - ms);
const HOUR = 3_600_000;
const MINUTE = 60_000;

describe('classifyNoticeTiming', () => {
  it.each([
    [2, 2 * HOUR, 'no_prazo'],
    [2, 2 * HOUR - 1, 'fora_do_prazo'],
    [2, 2 * HOUR + 1, 'no_prazo'],
    [4, 4 * HOUR, 'no_prazo'],
    [4, 4 * HOUR - MINUTE, 'fora_do_prazo'],
    [4, 30 * MINUTE, 'fora_do_prazo'],
  ])('limite de %i h, %i ms antes do início: %s', (limit, ms, expected) => {
    const result = classifyNoticeTiming(before(ms), START, limit);
    expect(result.timing).toBe(expected);
    expect(result.limitHoursApplied).toBe(limit);
    expect(result.minutesFromStart).toBeGreaterThan(0);
  });

  it('sem limite configurado, antes do início: sem_limite_configurado, sem limite aplicado', () => {
    for (const limit of [undefined, null]) {
      const result = classifyNoticeTiming(before(10 * HOUR), START, limit);
      expect(result).toEqual({ timing: 'sem_limite_configurado', minutesFromStart: 600 });
    }
  });

  it('1 ms antes do início ainda é antes: ao menos 1 minuto de antecedência', () => {
    const result = classifyNoticeTiming(before(1), START, 2);
    expect(result.timing).toBe('fora_do_prazo');
    expect(result.minutesFromStart).toBe(1);
  });

  it('no instante do início: depois_do_inicio, zero minutos, mesmo sem limite', () => {
    expect(classifyNoticeTiming(START, START, 2)).toEqual({ timing: 'depois_do_inicio', minutesFromStart: 0 });
    expect(classifyNoticeTiming(START, START, null)).toEqual({ timing: 'depois_do_inicio', minutesFromStart: 0 });
  });

  it('depois do início e horas depois do fim do horário: continua depois_do_inicio, sem limite final (DP-26)', () => {
    expect(classifyNoticeTiming(new Date(START.getTime() + 30_000), START, 2)).toEqual({ timing: 'depois_do_inicio', minutesFromStart: 0 });
    expect(classifyNoticeTiming(new Date(START.getTime() + 5 * HOUR), START, 2)).toEqual({ timing: 'depois_do_inicio', minutesFromStart: -300 });
  });
});

describe('AppointmentNotice.recordFromPanel', () => {
  const appointment = Appointment.reconstitute({
    id: 'a1',
    tenantId: '11111111-1111-1111-1111-111111111111',
    patientId: 'p1',
    therapistId: 't1',
    scheduledAt: START,
    modality: 'presencial',
    state: 'Confirmada',
    recurring: false,
  });

  it('o horário de referência é o do registro, e quem pediu fica à parte de quem registrou (DP-25)', () => {
    const now = before(HOUR);
    const notice = AppointmentNotice.recordFromPanel({
      id: 'n1',
      appointment,
      intent: 'pedido_cancelamento',
      requestedBy: 'clinica',
      reason: '  agenda do profissional  ',
      recordedByUserId: 'u1',
      now,
      cancellationLimitHours: 24,
    });
    expect(notice.channel).toBe('painel');
    expect(notice.referenceSource).toBe('registro_no_painel');
    expect(notice.referenceTime).toEqual(now);
    expect(notice.recordedAt).toEqual(now);
    expect(notice.timing).toBe('fora_do_prazo');
    expect(notice.requestedBy).toBe('clinica');
    expect(notice.recordedByUserId).toBe('u1');
    expect(notice.recordedByActorType).toBe('user');
    expect(notice.reason).toBe('agenda do profissional');
    expect(notice.reviewStatus).toBe('sem_revisao_necessaria');
  });

  it('o motivo não entra na auditoria', () => {
    const notice = AppointmentNotice.recordFromPanel({
      id: 'n2',
      appointment,
      intent: 'pedido_cancelamento',
      requestedBy: 'paciente',
      reason: 'informação que não pode ir para a auditoria',
      recordedByUserId: 'u1',
      now: before(HOUR),
    });
    const [event] = notice.pullDomainEvents();
    expect(event.eventName).toBe('ComunicacaoRegistrada');
    expect(JSON.stringify(event)).not.toContain('informação que não pode');
  });

  it('motivo com mais de 200 caracteres é recusado', () => {
    expect(() =>
      AppointmentNotice.recordFromPanel({
        id: 'n3',
        appointment,
        intent: 'pedido_cancelamento',
        requestedBy: 'paciente',
        reason: 'x'.repeat(201),
        recordedByUserId: 'u1',
        now: before(HOUR),
      }),
    ).toThrow(/200/);
  });
});
