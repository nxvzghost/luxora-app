import { describe, it, expect } from 'vitest';
import { Appointment, AppointmentState } from '@domain/appointment/appointment.entity';
import { AppointmentNotice } from '@domain/appointment/appointment-notice';
import { AppointmentOutcomeRecord, AppointmentRuleViolation } from '@domain/appointment/appointment-outcome';

/**
 * K2-b (ADR-0069, seções 2.4 a 2.6) — transições permitidas e proibidas do
 * desfecho da consulta.
 */
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const START = new Date('2026-08-10T15:00:00Z');
const AFTER = new Date(START.getTime() + 60 * 60_000);
const BEFORE = new Date(START.getTime() - 60 * 60_000);

function appointmentIn(state: AppointmentState): Appointment {
  return Appointment.reconstitute({
    id: 'a1',
    tenantId: TENANT_ID,
    patientId: 'p1',
    therapistId: 't1',
    scheduledAt: START,
    modality: 'online',
    state,
    recurring: false,
  });
}

function ruleCode(work: () => unknown): string {
  try {
    work();
  } catch (err) {
    if (err instanceof AppointmentRuleViolation) return err.code;
    throw err;
  }
  return 'sem erro';
}

const by = { userId: 'u1', now: AFTER };

describe('Realização (T6) e falta (T7)', () => {
  it.each(['Reservada', 'Confirmada', 'Reagendada'] as const)('de %s, depois do início: registra, com o retrato da consulta', (state) => {
    const appointment = appointmentIn(state);
    const realized = AppointmentOutcomeRecord.recordAttendance(appointment, by);
    expect(realized.outcome).toBe('Realizada');
    expect([realized.stateAtOutcome, realized.scheduledAtAtOutcome, realized.modalityAtOutcome]).toEqual([state, START, 'online']);
    expect([realized.recordedByUserId, realized.recordedAt]).toEqual(['u1', AFTER]);

    const noShow = AppointmentOutcomeRecord.recordNoShow(appointment, by);
    expect([noShow.outcome, noShow.noShowDecision]).toEqual(['Falta', 'aguardando_decisao']);
    expect(noShow.pullDomainEvents().map((e) => e.eventName)).toEqual(['FaltaRegistrada']);
  });

  it('antes do início: APPOINTMENT_NOT_STARTED (realização nunca é inferida da confirmação)', () => {
    expect(ruleCode(() => AppointmentOutcomeRecord.recordAttendance(appointmentIn('Confirmada'), { userId: 'u1', now: BEFORE }))).toBe('APPOINTMENT_NOT_STARTED');
    expect(ruleCode(() => AppointmentOutcomeRecord.recordNoShow(appointmentIn('Confirmada'), { userId: 'u1', now: BEFORE }))).toBe('APPOINTMENT_NOT_STARTED');
  });

  it('no instante exato do início já pode', () => {
    expect(AppointmentOutcomeRecord.recordAttendance(appointmentIn('Confirmada'), { userId: 'u1', now: START }).outcome).toBe('Realizada');
  });

  it.each(['Criada', 'ReagendamentoSolicitado', 'Cancelada'] as const)('de %s: APPOINTMENT_OUTCOME_CONFLICT', (state) => {
    expect(ruleCode(() => AppointmentOutcomeRecord.recordAttendance(appointmentIn(state), by))).toBe('APPOINTMENT_OUTCOME_CONFLICT');
    expect(ruleCode(() => AppointmentOutcomeRecord.recordNoShow(appointmentIn(state), by))).toBe('APPOINTMENT_OUTCOME_CONFLICT');
  });
});

describe('Cancelamento (T3) e remarcação (T5)', () => {
  function notice(requestedBy: 'paciente' | 'clinica' | 'profissional', limit: number | null, now = BEFORE) {
    return AppointmentNotice.recordFromPanel({
      id: 'n1',
      appointment: appointmentIn('Confirmada'),
      intent: 'pedido_cancelamento',
      requestedBy,
      recordedByUserId: 'u1',
      now,
      cancellationLimitHours: limit,
    });
  }

  it('só grava com a consulta já Cancelada (a ordem do banco)', () => {
    expect(() => AppointmentOutcomeRecord.closeByNotice(appointmentIn('Confirmada'), notice('paciente', 24), 'Cancelada', by)).toThrow(/depois de a consulta ficar Cancelada/);
  });

  it('pedido do paciente fora do prazo abre a decisão de consequência (DP-22, decisão humana)', () => {
    const record = AppointmentOutcomeRecord.closeByNotice(appointmentIn('Cancelada'), notice('paciente', 24), 'Cancelada', by);
    expect([record.outcome, record.stateAtOutcome, record.closingNoticeId, record.closingNoticeTiming, record.lateNoticeDecision]).toEqual([
      'Cancelada',
      'Cancelada',
      'n1',
      'fora_do_prazo',
      'aguardando_decisao',
    ]);
  });

  it.each(['clinica', 'profissional'] as const)('pedido de %s fora do prazo nunca abre consequência para o paciente (DP-25)', (requestedBy) => {
    expect(AppointmentOutcomeRecord.closeByNotice(appointmentIn('Cancelada'), notice(requestedBy, 24), 'Cancelada', by).lateNoticeDecision).toBeUndefined();
  });

  it('no prazo ou sem limite: sem decisão de consequência', () => {
    expect(AppointmentOutcomeRecord.closeByNotice(appointmentIn('Cancelada'), notice('paciente', 1), 'Remarcada', by).lateNoticeDecision).toBeUndefined();
    expect(AppointmentOutcomeRecord.closeByNotice(appointmentIn('Cancelada'), notice('paciente', null), 'Remarcada', by).lateNoticeDecision).toBeUndefined();
  });

  it('com comunicação depois do início: APPOINTMENT_ALREADY_STARTED', () => {
    expect(ruleCode(() => AppointmentOutcomeRecord.closeByNotice(appointmentIn('Cancelada'), notice('paciente', 24, AFTER), 'Cancelada', by))).toBe('APPOINTMENT_ALREADY_STARTED');
  });

  it('o evento da remarcação aponta a ocorrência nova; o do cancelamento não leva o motivo', () => {
    const record = AppointmentOutcomeRecord.closeByNotice(appointmentIn('Cancelada'), notice('paciente', null), 'Remarcada', { ...by, newAppointmentId: 'a2' });
    const [event] = record.pullDomainEvents();
    expect(event.eventName).toBe('ConsultaRemarcada');
    expect((event as unknown as { newAppointmentId: string }).newAppointmentId).toBe('a2');
  });
});

describe('Decisões sobre a falta (T8, T9, T9b)', () => {
  const noShow = () => AppointmentOutcomeRecord.recordNoShow(appointmentIn('Confirmada'), by);

  it('T8: confirma a cobrança; repetir não muda nada', () => {
    const record = noShow();
    record.pullDomainEvents();
    expect(record.confirmNoShowCharge({ userId: 'admin', now: AFTER, sessionId: 's1' })).toBe('applied');
    expect([record.noShowDecision, record.noShowDecisionByUserId, record.noShowDecisionAt]).toEqual(['cobranca_confirmada', 'admin', AFTER]);
    expect(record.pullDomainEvents().map((e) => e.eventName)).toEqual(['CobrancaDeFaltaConfirmada']);
    expect(record.confirmNoShowCharge({ userId: 'admin', now: AFTER, sessionId: 's1' })).toBe('unchanged');
    expect(record.pullDomainEvents()).toHaveLength(0);
  });

  it('T9: abono só com motivo (DP-23); vira FaltaAbonada, sem decisão de cobrança', () => {
    const record = noShow();
    expect(ruleCode(() => record.excuseNoShow({ userId: 'admin', now: AFTER, reason: '   ' }))).toBe('REASON_REQUIRED');
    expect(ruleCode(() => record.excuseNoShow({ userId: 'admin', now: AFTER }))).toBe('REASON_REQUIRED');
    expect(record.excuseNoShow({ userId: 'admin', now: AFTER, reason: 'atestado' })).toBe('applied');
    expect([record.outcome, record.noShowDecision]).toEqual(['FaltaAbonada', undefined]);
    expect(record.excuseNoShow({ userId: 'admin', now: AFTER, reason: 'atestado' })).toBe('unchanged');
  });

  it('T9 depois da cobrança confirmada: NO_SHOW_DECISION_CLOSED', () => {
    const record = noShow();
    record.confirmNoShowCharge({ userId: 'admin', now: AFTER, sessionId: 's1' });
    expect(ruleCode(() => record.excuseNoShow({ userId: 'admin', now: AFTER, reason: 'x' }))).toBe('NO_SHOW_DECISION_CLOSED');
  });

  it('T8 com a falta abonada: NO_SHOW_DECISION_CLOSED', () => {
    const record = noShow();
    record.excuseNoShow({ userId: 'admin', now: AFTER, reason: 'atestado' });
    expect(ruleCode(() => record.confirmNoShowCharge({ userId: 'admin', now: AFTER, sessionId: 's1' }))).toBe('NO_SHOW_DECISION_CLOSED');
  });

  it('T9b: reverter o abono volta à decisão humana, sem cobrança (DP-24a); exige motivo', () => {
    const record = noShow();
    record.excuseNoShow({ userId: 'admin', now: AFTER, reason: 'atestado' });
    record.pullDomainEvents();
    expect(ruleCode(() => record.revertExcuse({ userId: 'admin', now: AFTER }))).toBe('REASON_REQUIRED');
    expect(record.revertExcuse({ userId: 'admin', now: AFTER, reason: 'atestado inválido' })).toBe('applied');
    expect([record.outcome, record.noShowDecision]).toEqual(['Falta', 'aguardando_decisao']);
    expect(record.pullDomainEvents().map((e) => e.eventName)).toEqual(['AbonoRevertido']);
    // De novo aguardando decisão: pode ser abonada ou cobrada outra vez.
    expect(record.confirmNoShowCharge({ userId: 'admin', now: AFTER, sessionId: 's1' })).toBe('applied');
  });

  it('T9b sem abono: APPOINTMENT_OUTCOME_CONFLICT', () => {
    const record = noShow();
    record.confirmNoShowCharge({ userId: 'admin', now: AFTER, sessionId: 's1' });
    expect(ruleCode(() => record.revertExcuse({ userId: 'admin', now: AFTER, reason: 'x' }))).toBe('APPOINTMENT_OUTCOME_CONFLICT');
  });

  it('decisões de falta numa consulta realizada: APPOINTMENT_OUTCOME_CONFLICT', () => {
    const realized = AppointmentOutcomeRecord.recordAttendance(appointmentIn('Confirmada'), by);
    expect(ruleCode(() => realized.confirmNoShowCharge({ userId: 'admin', now: AFTER, sessionId: 's1' }))).toBe('APPOINTMENT_OUTCOME_CONFLICT');
    expect(ruleCode(() => realized.excuseNoShow({ userId: 'admin', now: AFTER, reason: 'x' }))).toBe('APPOINTMENT_OUTCOME_CONFLICT');
  });

  it('o motivo do abono e da reversão não entra nos eventos (auditoria)', () => {
    const record = noShow();
    record.excuseNoShow({ userId: 'admin', now: AFTER, reason: 'motivo-sigiloso-1' });
    record.revertExcuse({ userId: 'admin', now: AFTER, reason: 'motivo-sigiloso-2' });
    expect(JSON.stringify(record.pullDomainEvents())).not.toMatch(/motivo-sigiloso/);
  });
});
