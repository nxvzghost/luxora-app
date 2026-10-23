import { describe, it, expect } from 'vitest';
import {
  AbonarFaltaUseCase,
  ConfirmarCobrancaDeFaltaUseCase,
  RegistrarFaltaUseCase,
  RegistrarRealizacaoUseCase,
  ReverterAbonoUseCase,
} from '@use-cases/appointment/desfecho-consulta.use-case';
import { CancelarConsultaUseCase } from '@use-cases/appointment/gerenciar-consulta.use-case';
import { AFTER_START, BEFORE_START, START, World, appointmentIn, createWorld, errorOf, legacySession, withAppointment } from './support/lifecycle-world';

/**
 * K2-b (ADR-0069, seção 2.5) — T6, T7, T8, T9 e T9b, com as transições
 * proibidas da seção 2.6.
 */
const realizar = (w: World) => new RegistrarRealizacaoUseCase(w.repo, w.outcomeRepo, w.sessionRepo, w.audit as never, w.unitOfWork, w.clock, w.tenantContext);
const faltar = (w: World) => new RegistrarFaltaUseCase(w.repo, w.outcomeRepo, w.audit as never, w.unitOfWork, w.clock, w.tenantContext);
const cobrarFalta = (w: World) => new ConfirmarCobrancaDeFaltaUseCase(w.repo, w.outcomeRepo, w.sessionRepo, w.audit as never, w.unitOfWork, w.clock, w.tenantContext);
const abonar = (w: World) => new AbonarFaltaUseCase(w.repo, w.outcomeRepo, w.audit as never, w.unitOfWork, w.clock, w.tenantContext);
const reverter = (w: World) => new ReverterAbonoUseCase(w.repo, w.outcomeRepo, w.audit as never, w.unitOfWork, w.clock, w.tenantContext);
const cancelar = (w: World) =>
  new CancelarConsultaUseCase(w.repo, w.outcomeRepo, w.noticeRepo, w.clinicRepo as never, w.audit as never, w.unitOfWork, w.clock, w.tenantContext);

function startedWorld(state: 'Reservada' | 'Confirmada' | 'Reagendada' = 'Confirmada', options: Parameters<typeof createWorld>[0] = {}) {
  const world = createWorld(options);
  withAppointment(world, appointmentIn(state));
  world.now.value = AFTER_START;
  return world;
}

describe('RegistrarRealizacaoUseCase (T6)', () => {
  it.each(['Reservada', 'Confirmada', 'Reagendada'] as const)('de %s, depois do início: desfecho Realizada e item atendimento elegível', async (state) => {
    const world = startedWorld(state);
    const result = await realizar(world).execute('a1');
    expect(result.changed).toBe(true);
    expect(world.outcomes.get('a1')?.outcome).toBe('Realizada');
    expect(result.session?.kind).toBe('atendimento');
    expect(result.session?.isBillable).toBe(true);
    expect(result.session?.completedAt).toEqual(AFTER_START);
    expect(world.sessions.size).toBe(1);
    expect(world.audited.map((e) => e.eventName)).toEqual(['RealizacaoRegistrada', 'SessaoEstadoAlterado']);
  });

  it('antes do início: APPOINTMENT_NOT_STARTED, nada gravado — confirmação não é realização', async () => {
    const world = createWorld();
    withAppointment(world, appointmentIn('Confirmada'));
    world.now.value = new Date(START.getTime() - 1);
    expect(await errorOf(realizar(world).execute('a1'))).toEqual({ status: 409, code: 'APPOINTMENT_NOT_STARTED' });
    expect(world.outcomes.size).toBe(0);
    expect(world.sessions.size).toBe(0);
  });

  it('reaproveita a sessão legada da consulta (criada pela confirmação antes da K2-b): nunca recria', async () => {
    const world = startedWorld();
    const session = legacySession();
    world.sessions.set(session.id, session);
    const result = await realizar(world).execute('a1');
    expect(result.session?.id).toBe('s-legada');
    expect(world.sessions.size).toBe(1);
    expect([session.kind, session.billingEligibility, session.isBillable]).toEqual(['atendimento', 'elegivel', true]);
    expect(world.audited.map((e) => e.eventName)).toEqual(['RealizacaoRegistrada', 'SessaoTornadaElegivel']);
  });

  it('sessão legada já cobrada não é tocada: o desfecho fica registrado e a cobrança segue o ciclo normal', async () => {
    const world = startedWorld();
    const session = legacySession({ state: 'Faturada' });
    world.sessions.set(session.id, session);
    const result = await realizar(world).execute('a1');
    expect(world.outcomes.get('a1')?.outcome).toBe('Realizada');
    expect(world.sessionRepo.save).not.toHaveBeenCalled();
    expect([result.session?.state, session.kind, session.billingEligibility]).toEqual(['Faturada', undefined, 'nao_elegivel']);
  });

  it('repetir: 200 sem evento novo; outro desfecho registrado: APPOINTMENT_OUTCOME_CONFLICT', async () => {
    const world = startedWorld();
    await realizar(world).execute('a1');
    world.audited.length = 0;
    const again = await realizar(world).execute('a1');
    expect(again.changed).toBe(false);
    expect(world.audited).toHaveLength(0);
    expect(world.sessions.size).toBe(1);
    expect(await errorOf(faltar(world).execute('a1'))).toEqual({ status: 409, code: 'APPOINTMENT_OUTCOME_CONFLICT' });
  });

  it('consulta cancelada: APPOINTMENT_OUTCOME_CONFLICT', async () => {
    const world = createWorld();
    withAppointment(world, appointmentIn('Confirmada'));
    await cancelar(world).execute('a1', { requestedBy: 'paciente' });
    world.now.value = AFTER_START;
    expect(await errorOf(realizar(world).execute('a1'))).toEqual({ status: 409, code: 'APPOINTMENT_OUTCOME_CONFLICT' });
  });

  it('sem usuário humano: 403 HUMAN_ACTOR_REQUIRED (a IA nunca registra desfecho)', async () => {
    const world = startedWorld('Confirmada', { userId: null });
    expect(await errorOf(realizar(world).execute('a1'))).toEqual({ status: 403, code: 'HUMAN_ACTOR_REQUIRED' });
    expect(await errorOf(faltar(world).execute('a1'))).toEqual({ status: 403, code: 'HUMAN_ACTOR_REQUIRED' });
  });
});

describe('RegistrarFaltaUseCase (T7)', () => {
  it('depois do início: Falta aguardando decisão; nenhum item faturável nasce', async () => {
    const world = startedWorld();
    const result = await faltar(world).execute('a1');
    expect([result.outcome?.outcome, result.outcome?.noShowDecision]).toEqual(['Falta', 'aguardando_decisao']);
    expect(world.sessions.size).toBe(0);
    expect(world.sessionRepo.save).not.toHaveBeenCalled();
  });

  it('antes do início: APPOINTMENT_NOT_STARTED', async () => {
    const world = createWorld();
    withAppointment(world, appointmentIn('Reservada'));
    world.now.value = BEFORE_START;
    expect(await errorOf(faltar(world).execute('a1'))).toEqual({ status: 409, code: 'APPOINTMENT_NOT_STARTED' });
  });

  it('a sessão legada da consulta continua inelegível', async () => {
    const world = startedWorld();
    const session = legacySession();
    world.sessions.set(session.id, session);
    await faltar(world).execute('a1');
    expect(session.isBillable).toBe(false);
  });
});

describe('ConfirmarCobrancaDeFaltaUseCase (T8)', () => {
  it('cria o item falta elegível e registra a decisão no histórico', async () => {
    const world = startedWorld();
    await faltar(world).execute('a1');
    const result = await cobrarFalta(world).execute('a1');
    expect(result.changed).toBe(true);
    expect([result.session?.kind, result.session?.isBillable]).toEqual(['falta', true]);
    expect(world.outcomes.get('a1')?.noShowDecision).toBe('cobranca_confirmada');
    expect(world.decisions.map((d) => [d.decision, d.decidedByUserId])).toEqual([['cobranca_de_falta_confirmada', 'user-1']]);
    expect(world.audited.map((e) => e.eventName)).toContain('CobrancaDeFaltaConfirmada');
  });

  it('repetir: sem efeito e sem segundo item', async () => {
    const world = startedWorld();
    await faltar(world).execute('a1');
    await cobrarFalta(world).execute('a1');
    const again = await cobrarFalta(world).execute('a1');
    expect(again.changed).toBe(false);
    expect(world.sessions.size).toBe(1);
    expect(world.decisions).toHaveLength(1);
  });

  it('reaproveita a sessão legada não cobrada como item falta', async () => {
    const world = startedWorld();
    const session = legacySession();
    world.sessions.set(session.id, session);
    await faltar(world).execute('a1');
    const result = await cobrarFalta(world).execute('a1');
    expect(result.session?.id).toBe('s-legada');
    expect(session.kind).toBe('falta');
  });

  it('com sessão legada já cobrada: SESSION_ALREADY_BILLED e a decisão não é gravada', async () => {
    const world = startedWorld();
    world.sessions.set('s-legada', legacySession({ state: 'Recebida' }));
    await faltar(world).execute('a1');
    expect(await errorOf(cobrarFalta(world).execute('a1'))).toEqual({ status: 409, code: 'SESSION_ALREADY_BILLED' });
    expect(world.outcomes.get('a1')?.noShowDecision).toBe('aguardando_decisao');
    expect(world.decisions).toHaveLength(0);
  });

  it('consulta realizada ou sem desfecho: APPOINTMENT_OUTCOME_CONFLICT; inexistente: 404', async () => {
    const world = startedWorld();
    expect(await errorOf(cobrarFalta(world).execute('a1'))).toEqual({ status: 409, code: 'APPOINTMENT_OUTCOME_CONFLICT' });
    await realizar(world).execute('a1');
    expect(await errorOf(cobrarFalta(world).execute('a1'))).toEqual({ status: 409, code: 'APPOINTMENT_OUTCOME_CONFLICT' });
    expect((await errorOf(cobrarFalta(world).execute('nao-existe'))).status).toBe(404);
  });
});

describe('AbonarFaltaUseCase (T9) e ReverterAbonoUseCase (T9b)', () => {
  it('abono com motivo: FaltaAbonada, motivo no histórico de decisões e fora da auditoria', async () => {
    const world = startedWorld();
    await faltar(world).execute('a1');
    const result = await abonar(world).execute('a1', { reason: 'atestado médico', actorRole: 'admin' });
    expect(result.outcome?.outcome).toBe('FaltaAbonada');
    expect(world.decisions.map((d) => [d.decision, d.reason])).toEqual([['falta_abonada', 'atestado médico']]);
    expect(JSON.stringify(world.audited)).not.toContain('atestado');
    expect(world.sessions.size).toBe(0);
  });

  it('super_admin nunca abona (DP-23), mesmo passando pelo RolesGuard', async () => {
    const world = startedWorld();
    await faltar(world).execute('a1');
    expect(await errorOf(abonar(world).execute('a1', { reason: 'x', actorRole: 'super_admin' }))).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(world.outcomes.get('a1')?.outcome).toBe('Falta');
  });

  it('sem motivo: 400 REASON_REQUIRED', async () => {
    const world = startedWorld();
    await faltar(world).execute('a1');
    expect(await errorOf(abonar(world).execute('a1', { reason: ' ', actorRole: 'admin' }))).toEqual({ status: 400, code: 'REASON_REQUIRED' });
    expect(await errorOf(abonar(world).execute('a1', { actorRole: 'admin' }))).toEqual({ status: 400, code: 'REASON_REQUIRED' });
  });

  it('com a cobrança confirmada: NO_SHOW_DECISION_CLOSED', async () => {
    const world = startedWorld();
    await faltar(world).execute('a1');
    await cobrarFalta(world).execute('a1');
    expect(await errorOf(abonar(world).execute('a1', { reason: 'x', actorRole: 'admin' }))).toEqual({ status: 409, code: 'NO_SHOW_DECISION_CLOSED' });
  });

  it('reverter o abono volta à decisão humana sem cobrar; o histórico guarda as duas decisões com os motivos', async () => {
    const world = startedWorld();
    await faltar(world).execute('a1');
    await abonar(world).execute('a1', { reason: 'primeiro motivo', actorRole: 'admin' });
    const reverted = await reverter(world).execute('a1', { reason: 'atestado inválido' });
    expect([reverted.outcome?.outcome, reverted.outcome?.noShowDecision]).toEqual(['Falta', 'aguardando_decisao']);
    expect(world.sessions.size).toBe(0);
    await abonar(world).execute('a1', { reason: 'segundo motivo', actorRole: 'admin' });
    expect(world.decisions.map((d) => [d.decision, d.reason])).toEqual([
      ['falta_abonada', 'primeiro motivo'],
      ['abono_revertido', 'atestado inválido'],
      ['falta_abonada', 'segundo motivo'],
    ]);
  });

  it('reverter sem abono: APPOINTMENT_OUTCOME_CONFLICT (com cobrança confirmada) ou sem efeito (já aguardando)', async () => {
    const world = startedWorld();
    await faltar(world).execute('a1');
    expect((await reverter(world).execute('a1', { reason: 'x' })).changed).toBe(false);
    await cobrarFalta(world).execute('a1');
    expect(await errorOf(reverter(world).execute('a1', { reason: 'x' }))).toEqual({ status: 409, code: 'APPOINTMENT_OUTCOME_CONFLICT' });
  });
});
