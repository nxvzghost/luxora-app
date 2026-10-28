import { describe, it, expect } from 'vitest';
import { AppointmentNotice } from '@domain/appointment/appointment-notice';
import { AppointmentOutcomeRecord, AppointmentRuleViolation } from '@domain/appointment/appointment-outcome';
import { deriveRequestStatus } from '@domain/appointment/appointment-request';
import { AFTER_START, BEFORE_START, CONVERSATION_ID, NEW_SLOT, START, appointmentIn } from '../../use-cases/appointment/support/lifecycle-world';

/**
 * K11 — o pedido pelo WhatsApp e a resposta do paciente como comunicações
 * distintas (D2), o estado derivado delas (D6) e o desfecho de autoria da IA
 * (D1). ADR-0069, decisões de 23/10/2026.
 */

const message = (messageId: string, receivedAt: Date, conversationId = CONVERSATION_ID) => ({ conversationId, messageId, receivedAt });
const ASKED_AT = new Date(BEFORE_START.getTime() - 3_600_000);
const ANSWERED_AT = new Date(ASKED_AT.getTime() + 5 * 60_000);

function request(action: 'cancelar' | 'remarcar' = 'cancelar', appointment = appointmentIn('Confirmada')) {
  return AppointmentNotice.requestFromWhatsApp({
    id: `pedido-${action}`,
    appointment,
    intent: action === 'remarcar' ? 'pedido_remarcacao' : 'pedido_cancelamento',
    proposedScheduledAt: action === 'remarcar' ? NEW_SLOT : undefined,
    message: message('wamid.pedido', ASKED_AT),
    now: ASKED_AT,
    cancellationLimitHours: 24,
  });
}

function reply(of: AppointmentNotice, answer: 'confirma' | 'recusa' | 'ambigua', at = ANSWERED_AT, appointment = appointmentIn('Confirmada')) {
  return AppointmentNotice.replyFromWhatsApp({
    id: `resposta-${answer}`,
    request: of,
    appointment,
    answer,
    message: message(`wamid.${answer}`, at),
    now: at,
    cancellationLimitHours: 24,
  });
}

describe('AppointmentNotice.requestFromWhatsApp — o pedido (K11)', () => {
  it('aguarda confirmação, guarda o retrato da consulta perguntada e é da IA, pelo WhatsApp, a pedido do paciente', () => {
    const notice = request();
    expect([notice.awaitsConfirmation, notice.requestedAction, notice.askedScheduledAt, notice.askedModality]).toEqual([true, 'cancelar', START, 'presencial']);
    expect([notice.channel, notice.recordedByActorType, notice.requestedBy, notice.intentSource, notice.referenceSource]).toEqual([
      'whatsapp',
      'ai_agent',
      'paciente',
      'ia',
      'recebimento_webhook',
    ]);
    expect([notice.timing, notice.reviewStatus, notice.confirmsNoticeId]).toEqual(['no_prazo', 'sem_revisao_necessaria', undefined]);
    expect(notice.pullDomainEvents().map((e) => e.eventName)).toEqual(['ComunicacaoRegistrada']);
  });

  it('D7 — "não vou conseguir ir" vira pedido de cancelamento', () => {
    const notice = AppointmentNotice.requestFromWhatsApp({
      id: 'n',
      appointment: appointmentIn('Confirmada'),
      intent: 'nao_comparecera',
      message: message('wamid.1', ASKED_AT),
      now: ASKED_AT,
    });
    expect([notice.intent, notice.requestedAction]).toEqual(['nao_comparecera', 'cancelar']);
  });

  it('só a remarcação leva horário novo, e ela sempre leva', () => {
    expect(() =>
      AppointmentNotice.requestFromWhatsApp({ id: 'n', appointment: appointmentIn('Confirmada'), intent: 'pedido_remarcacao', message: message('w', ASKED_AT), now: ASKED_AT }),
    ).toThrow();
    expect(() =>
      AppointmentNotice.requestFromWhatsApp({
        id: 'n',
        appointment: appointmentIn('Confirmada'),
        intent: 'pedido_cancelamento',
        proposedScheduledAt: NEW_SLOT,
        message: message('w', ASKED_AT),
        now: ASKED_AT,
      }),
    ).toThrow();
    expect(request('remarcar').proposedScheduledAt).toEqual(NEW_SLOT);
  });

  it('não abre pedido no início nem depois dele', () => {
    expect(() =>
      AppointmentNotice.requestFromWhatsApp({ id: 'n', appointment: appointmentIn('Confirmada'), intent: 'pedido_cancelamento', message: message('w', START), now: START }),
    ).toThrow();
  });

  it('stillDescribes: a consulta mudada de horário ou de modalidade não é mais a perguntada', () => {
    const notice = request();
    expect(notice.stillDescribes(appointmentIn('Confirmada'))).toBe(true);
    expect(notice.stillDescribes(appointmentIn('Confirmada', { scheduledAt: new Date(START.getTime() + 60_000) }))).toBe(false);
    expect(notice.stillDescribes(appointmentIn('Confirmada', { id: 'a2' }))).toBe(false);
  });
});

describe('AppointmentNotice.replyFromWhatsApp — a resposta, em outra linha (D2)', () => {
  it('liga-se ao pedido, sem alterar o pedido', () => {
    const asked = request();
    const answer = reply(asked, 'confirma');
    expect([answer.confirmsNoticeId, answer.confirmationAnswer, answer.awaitsConfirmation, answer.requestedAction]).toEqual([
      asked.id,
      'confirma',
      false,
      undefined,
    ]);
    expect([answer.reviewStatus, answer.isBeforeStart]).toEqual(['sem_revisao_necessaria', true]);
    expect([asked.awaitsConfirmation, asked.confirmationAnswer]).toEqual([true, undefined]);
  });

  it('recusa, ambígua, tardia ou marcada para revisão: fica pendente de revisão da equipe', () => {
    const asked = request();
    expect(reply(asked, 'recusa').reviewStatus).toBe('pendente');
    expect(reply(asked, 'ambigua').reviewStatus).toBe('pendente');
    const late = reply(asked, 'confirma', AFTER_START);
    expect([late.timing, late.reviewStatus, late.isBeforeStart]).toEqual(['depois_do_inicio', 'pendente', false]);
    const flagged = AppointmentNotice.replyFromWhatsApp({
      id: 'r',
      request: asked,
      appointment: appointmentIn('Confirmada'),
      answer: 'confirma',
      message: message('wamid.r', ANSWERED_AT),
      now: ANSWERED_AT,
      needsReview: true,
    });
    expect(flagged.reviewStatus).toBe('pendente');
  });

  it('D4 — nunca na mensagem do próprio pedido, nunca de outra conversa, nunca de outra consulta', () => {
    const asked = request();
    const base = { id: 'r', request: asked, appointment: appointmentIn('Confirmada'), answer: 'confirma' as const, now: ANSWERED_AT };
    expect(() => AppointmentNotice.replyFromWhatsApp({ ...base, message: message('wamid.pedido', ANSWERED_AT) })).toThrow();
    expect(() => AppointmentNotice.replyFromWhatsApp({ ...base, message: message('wamid.x', ANSWERED_AT, 'outra-conversa') })).toThrow();
    expect(() => AppointmentNotice.replyFromWhatsApp({ ...base, appointment: appointmentIn('Confirmada', { id: 'a2' }), message: message('wamid.x', ANSWERED_AT) })).toThrow();
    expect(() => AppointmentNotice.replyFromWhatsApp({ ...base, request: reply(asked, 'confirma'), message: message('wamid.y', ANSWERED_AT) })).toThrow();
  });
});

describe('deriveRequestStatus — o estado do pedido, derivado na leitura (D6)', () => {
  const facts = (over: Partial<Parameters<typeof deriveRequestStatus>[0]> = {}) => ({
    request: request(),
    replies: [],
    appointment: appointmentIn('Confirmada'),
    outcome: null,
    superseded: false,
    now: BEFORE_START,
    ...over,
  });

  it('aguardando antes do início; vencido quando o início chega sem resposta', () => {
    expect(deriveRequestStatus(facts())).toBe('aguardando');
    expect(deriveRequestStatus(facts({ now: START }))).toBe('vencido');
  });

  it('pela última resposta: recusado, encaminhado, ou confirmado sem execução (nao_executado)', () => {
    const asked = request();
    expect(deriveRequestStatus(facts({ request: asked, replies: [reply(asked, 'recusa')] }))).toBe('recusado');
    expect(deriveRequestStatus(facts({ request: asked, replies: [reply(asked, 'ambigua')] }))).toBe('encaminhado');
    expect(deriveRequestStatus(facts({ request: asked, replies: [reply(asked, 'confirma')] }))).toBe('nao_executado');
  });

  it('confirmado só com o desfecho da IA que fecha este pedido', () => {
    const asked = request();
    const answer = reply(asked, 'confirma');
    const appointment = appointmentIn('Confirmada');
    appointment.transitionTo('Cancelada');
    const outcome = AppointmentOutcomeRecord.closeByConfirmedRequest(appointment, asked, answer, 'Cancelada', { now: ANSWERED_AT });
    expect(deriveRequestStatus(facts({ request: asked, replies: [answer], appointment, outcome }))).toBe('confirmado');
  });

  it('substituído por um pedido mais novo; sem efeito quando a consulta mudou ou foi encerrada por outro caminho', () => {
    expect(deriveRequestStatus(facts({ superseded: true }))).toBe('substituido');
    expect(deriveRequestStatus(facts({ appointment: null }))).toBe('sem_efeito');
    expect(deriveRequestStatus(facts({ appointment: appointmentIn('Confirmada', { scheduledAt: new Date(START.getTime() + 3_600_000) }) }))).toBe('sem_efeito');
    expect(deriveRequestStatus(facts({ appointment: appointmentIn('Cancelada') }))).toBe('sem_efeito');
  });
});

describe('AppointmentOutcomeRecord.closeByConfirmedRequest — o desfecho de autoria da IA (D1)', () => {
  function cancelled() {
    const appointment = appointmentIn('Confirmada');
    appointment.transitionTo('Cancelada');
    return appointment;
  }

  it('sem usuário, ligado ao pedido e à confirmação, com a antecedência do pedido', () => {
    const asked = request();
    const answer = reply(asked, 'confirma');
    const outcome = AppointmentOutcomeRecord.closeByConfirmedRequest(cancelled(), asked, answer, 'Cancelada', { now: ANSWERED_AT });
    expect([outcome.recordedByActorType, outcome.recordedByUserId, outcome.closingNoticeId, outcome.closingRequestedAction]).toEqual([
      'ai_agent',
      undefined,
      asked.id,
      'cancelar',
    ]);
    expect([outcome.confirmationNoticeId, outcome.confirmationAnswer, outcome.confirmationNoticeTiming, outcome.closingNoticeTiming]).toEqual([
      answer.id,
      'confirma',
      'no_prazo',
      'no_prazo',
    ]);
    expect(outcome.pullDomainEvents().map((e) => [e.eventName, (e as unknown as { recordedBy: string }).recordedBy])).toEqual([['ConsultaCancelada', 'ai_agent']]);
  });

  it('pedido fora do prazo: a consequência fica aguardando decisão humana (D8)', () => {
    const appointment = appointmentIn('Confirmada');
    const lateAsk = AppointmentNotice.requestFromWhatsApp({
      id: 'p',
      appointment,
      intent: 'pedido_cancelamento',
      message: message('wamid.p', new Date(START.getTime() - 3_600_000)),
      now: new Date(START.getTime() - 3_600_000),
      cancellationLimitHours: 24,
    });
    const answer = reply(lateAsk, 'confirma', new Date(START.getTime() - 30 * 60_000));
    const outcome = AppointmentOutcomeRecord.closeByConfirmedRequest(cancelled(), lateAsk, answer, 'Cancelada', { now: START });
    expect([outcome.closingNoticeTiming, outcome.lateNoticeDecision]).toEqual(['fora_do_prazo', 'aguardando_decisao']);
  });

  it('recusa: sem confirmação, sem ação diferente da pedida, sem consulta ainda aberta, sem confirmação tardia', () => {
    const asked = request();
    expect(() => AppointmentOutcomeRecord.closeByConfirmedRequest(cancelled(), asked, reply(asked, 'recusa'), 'Cancelada', { now: ANSWERED_AT })).toThrow();
    expect(() => AppointmentOutcomeRecord.closeByConfirmedRequest(cancelled(), asked, reply(asked, 'confirma'), 'Remarcada', { now: ANSWERED_AT })).toThrow();
    expect(() =>
      AppointmentOutcomeRecord.closeByConfirmedRequest(appointmentIn('Confirmada'), asked, reply(asked, 'confirma'), 'Cancelada', { now: ANSWERED_AT }),
    ).toThrow();
    expect(() =>
      AppointmentOutcomeRecord.closeByConfirmedRequest(cancelled(), asked, reply(asked, 'confirma', AFTER_START), 'Cancelada', { now: AFTER_START }),
    ).toThrow(AppointmentRuleViolation);
    const other = request('remarcar');
    expect(() => AppointmentOutcomeRecord.closeByConfirmedRequest(cancelled(), asked, reply(other, 'confirma'), 'Cancelada', { now: ANSWERED_AT })).toThrow();
  });
});
