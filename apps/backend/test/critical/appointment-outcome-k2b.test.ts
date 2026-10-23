import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, UserRole } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';
import { uniquePastSlot, uniqueSlot } from './support/unique-slot';
import { attendedSession } from './support/attended-session';
import { K2B_CONSTRAINTS } from './support/k2b-constraints';
import { clinicTimeAt } from '../support/clinic-time';

/**
 * [CRÍTICO — K2-b] Desfecho da consulta e elegibilidade definitiva das
 * sessões para cobrança (ADR-0069, seções 2.4 a 2.9 e 3.7; exceção restrita
 * à ADR-0060).
 *
 * Três blocos:
 *   1. o ciclo pela API: confirmar não é realizar; realização e falta só
 *      depois do início, por pessoa; cobrança só de sessão elegível;
 *      remarcação com histórico; cancelamento com quem pediu; abono e
 *      reversão com motivo fora da auditoria; concorrência e isolamento;
 *   2. as proteções do banco, provadas com o papel da aplicação e sob RLS,
 *      inclusive com o SQL que a versão anterior (`fb93885`) emite: o
 *      congelamento da consulta com desfecho, a chave de elegibilidade do
 *      vínculo, os CHECKs e os privilégios;
 *   3. a guarda de CI: as restrições, a política e a exigência de versão
 *      continuam no banco.
 * Cada uma das 23 restrições, uma a uma, com controle e violação, está em
 * appointment-outcome-k2b-constraints.test.ts.
 * O ensaio com a imagem antiga de verdade está em infra/tests/k2b-compat-rehearsal.sh.
 */

let app: INestApplication;
let db: PrismaClient; // superusuário: montar cenário, ler o resultado
let appDb: PrismaClient; // papel da aplicação (luxora_app), como a aplicação
let clinicA: DedicatedFixture;
let clinicB: DedicatedFixture;
let tokenA: string;
let tokenB: string;
let adminUserId: string;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

const api = () => request(app.getHttpServer());
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

async function book(scheduledAt: string, token = tokenA, fixture = () => clinicA): Promise<string> {
  const res = await api()
    .post('/api/v1/appointments')
    .set(as(token))
    .send({ patientId: fixture().patientId, therapistId: fixture().therapistId, scheduledAt, modality: 'presencial' });
  expect(res.status).toBe(201);
  fixture().appointmentIds.push(res.body.id);
  return res.body.id;
}

/** Executa SQL com o papel da aplicação, sob a RLS da clínica — como a aplicação faz. */
async function asApp(tenantId: string, sql: string, ...params: unknown[]): Promise<number> {
  return appDb.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
    return tx.$executeRawUnsafe(sql, ...params);
  });
}

/** Várias instruções do papel da aplicação numa transação só (como a versão anterior grava cobrança e vínculo). */
async function asAppInTransaction(tenantId: string, statements: Array<[string, ...unknown[]]>): Promise<void> {
  await appDb.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
    for (const [sql, ...params] of statements) await tx.$executeRawUnsafe(sql, ...params);
  });
}

/** SQLSTATE do erro do PostgreSQL devolvido pelo Prisma numa consulta crua. */
async function sqlStateOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (err) {
    const message = String((err as Error).message);
    return message.match(/Code: `(\w+)`/)?.[1] ?? (err as { meta?: { code?: string } }).meta?.code ?? message;
  }
  return 'sem erro';
}

/** Sessão legada, como a confirmação da versão anterior a cria: só as colunas que ela conhece. */
const OLD_VERSION_SESSION_UPSERT = `
  INSERT INTO "public"."session" ("id","tenant_id","appointment_id","patient_id","therapist_id","state","created_at")
  VALUES ($1, $2, $3, $4, $5, CAST($6::text AS "public"."SessionState"), now())
  ON CONFLICT ("id") DO UPDATE SET "state" = CAST($6::text AS "public"."SessionState")`;

/** O upsert da consulta que a versão anterior emite (PrismaAppointmentRepository.upsertAll de `fb93885`). */
const OLD_VERSION_APPOINTMENT_UPSERT = `
  INSERT INTO "public"."appointment" ("id","tenant_id","patient_id","therapist_id","scheduled_at","modality","state","recurring","created_at","updated_at")
  VALUES ($1, $2, $3, $4, $5::timestamp, 'presencial', CAST($6::text AS "public"."AppointmentState"), false, now(), now())
  ON CONFLICT ("id") DO UPDATE SET "scheduled_at" = $5::timestamp, "modality" = 'presencial', "state" = CAST($6::text AS "public"."AppointmentState"), "updated_at" = now()`;

async function legacySessionFor(appointmentId: string, fixture = clinicA): Promise<string> {
  const id = randomUUID();
  expect(await asApp(fixture.tenantId, OLD_VERSION_SESSION_UPSERT, id, fixture.tenantId, appointmentId, fixture.patientId, fixture.therapistId, 'Realizada')).toBe(1);
  fixture.sessionIds.push(id);
  return id;
}

async function createBilling(sessionIds: string[], token = tokenA, patientId = clinicA.patientId) {
  return api().post('/api/v1/billings').set(as(token)).send({ patientId, amount: 400, dueDate: '2026-12-10', sessionIds });
}

async function auditOf(entityId: string) {
  return db.auditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } });
}

beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await db.$connect();
  appDb = new PrismaClient();
  await appDb.$connect();
  app = await bootstrapTestApp();

  clinicA = await createDedicatedFixture(db, 'K2B-A', { withActiveSubscription: true, withAvailabilityCalendar: true, withClinicSettings: true });
  clinicB = await createDedicatedFixture(db, 'K2B-B', { withActiveSubscription: true, withAvailabilityCalendar: true });
  tokenA = await createDedicatedUserAndLogin(db, app, clinicA, 'K2BA', UserRole.admin);
  adminUserId = clinicA.userId as string;
  tokenB = await createDedicatedUserAndLogin(db, app, clinicB, 'K2BB', UserRole.admin);
  await db.clinicSettings.update({ where: { id: clinicA.clinicSettingsId }, data: { cancellationHoursLimit: 48 } });
}, 60_000);

afterAll(async () => {
  await cleanupDedicatedFixture(db, clinicA);
  await cleanupDedicatedFixture(db, clinicB);
  await appDb.$disconnect();
  await db.$disconnect();
  await app.close();
});

describe('[CRÍTICO — K2-b] confirmar não é realizar; só sessão elegível é cobrada', () => {
  it('confirmar não cria sessão nem oferece nada para cobrança', async () => {
    const id = await book(uniqueSlot());
    const res = await api().post(`/api/v1/appointments/${id}/confirm`).set(as(tokenA));
    expect(res.status).toBe(201);
    expect(await db.session.count({ where: { appointmentId: id } })).toBe(0);
    const billable = await api().get(`/api/v1/sessions?state=Realizada&patientId=${clinicA.patientId}`).set(as(tokenA));
    expect(billable.body.data.map((s: { appointmentId: string }) => s.appointmentId)).not.toContain(id);
  });

  it('realização antes do início: 409 APPOINTMENT_NOT_STARTED, nada gravado', async () => {
    const id = await book(uniqueSlot());
    const res = await api().post(`/api/v1/appointments/${id}/attended`).set(as(tokenA));
    expect([res.status, res.body.error.code]).toEqual([409, 'APPOINTMENT_NOT_STARTED']);
    expect(await db.appointmentOutcomeRecord.count({ where: { appointmentId: id } })).toBe(0);
    expect(await db.session.count({ where: { appointmentId: id } })).toBe(0);
  });

  it('confirmar ou cancelar depois do início: 409 APPOINTMENT_ALREADY_STARTED', async () => {
    const id = await book(uniquePastSlot());
    const confirm = await api().post(`/api/v1/appointments/${id}/confirm`).set(as(tokenA));
    const cancel = await api().post(`/api/v1/appointments/${id}/cancel`).set(as(tokenA)).send({ requestedBy: 'paciente' });
    expect([confirm.status, confirm.body.error.code]).toEqual([409, 'APPOINTMENT_ALREADY_STARTED']);
    expect([cancel.status, cancel.body.error.code]).toEqual([409, 'APPOINTMENT_ALREADY_STARTED']);
    expect((await db.appointment.findUniqueOrThrow({ where: { id } })).state).toBe('Reservada');
  });

  it('realização depois do início: desfecho com retrato, item atendimento elegível, cobrável; repetir responde 200', async () => {
    const id = await book(uniquePastSlot());
    const res = await api().post(`/api/v1/appointments/${id}/attended`).set(as(tokenA));
    expect(res.status).toBe(201);
    expect(res.body.outcome.outcome).toBe('Realizada');
    expect(res.body.session).toMatchObject({ kind: 'atendimento', billingEligibility: 'elegivel', state: 'Realizada' });
    clinicA.sessionIds.push(res.body.session.id);

    const outcome = await db.appointmentOutcomeRecord.findUniqueOrThrow({ where: { appointmentId: id } });
    const appointment = await db.appointment.findUniqueOrThrow({ where: { id } });
    expect([outcome.stateAtOutcome, outcome.scheduledAtAtOutcome.toISOString(), outcome.modalityAtOutcome, outcome.outcomeRecordedByUserId]).toEqual([
      appointment.state,
      appointment.scheduledAt.toISOString(),
      appointment.modality,
      adminUserId,
    ]);
    const session = await db.session.findUniqueOrThrow({ where: { id: res.body.session.id } });
    expect(session.completedAt).not.toBeNull();

    const again = await api().post(`/api/v1/appointments/${id}/attended`).set(as(tokenA));
    expect(again.status).toBe(200);
    expect(await db.session.count({ where: { appointmentId: id } })).toBe(1);

    const billing = await createBilling([res.body.session.id]);
    expect(billing.status).toBe(201);
    clinicA.billingIds.push(billing.body.id);
    expect((await db.billingSession.findUniqueOrThrow({ where: { sessionId: res.body.session.id } })).requiredEligibility).toBe('elegivel');
  });

  it('sessão legada (criada pela confirmação da versão anterior): fora da lista a cobrar e recusada em POST /billings (SESSION_NOT_BILLABLE); a realização registrada a reaproveita', async () => {
    const id = await book(uniquePastSlot());
    const legacy = await legacySessionFor(id);
    expect(await db.session.findUniqueOrThrow({ where: { id: legacy } })).toMatchObject({ billingEligibility: 'nao_elegivel', kind: null });

    const listed = await api().get(`/api/v1/sessions?state=Realizada&patientId=${clinicA.patientId}`).set(as(tokenA));
    expect(listed.body.data.map((s: { id: string }) => s.id)).not.toContain(legacy);
    const before = await db.billing.count({ where: { tenantId: clinicA.tenantId } });
    const refused = await createBilling([legacy]);
    expect([refused.status, refused.body.error.code]).toEqual([409, 'SESSION_NOT_BILLABLE']);
    expect(await db.billing.count({ where: { tenantId: clinicA.tenantId } })).toBe(before);

    const attended = await api().post(`/api/v1/appointments/${id}/attended`).set(as(tokenA));
    expect(attended.body.session.id).toBe(legacy);
    expect(await db.session.findUniqueOrThrow({ where: { id: legacy } })).toMatchObject({ billingEligibility: 'elegivel', kind: 'atendimento' });
    const billing = await createBilling([legacy]);
    expect(billing.status).toBe(201);
    clinicA.billingIds.push(billing.body.id);
  });
});

describe('[CRÍTICO — K2-b] falta, cobrança da falta, abono e reversão', () => {
  it('falta não cria item; cobrança confirmada cria o item falta, cobrável; tudo com autor', async () => {
    const id = await book(uniquePastSlot());
    const noShow = await api().post(`/api/v1/appointments/${id}/no-show`).set(as(tokenA));
    expect(noShow.body.outcome).toMatchObject({ outcome: 'Falta', noShowDecision: 'aguardando_decisao' });
    expect(await db.session.count({ where: { appointmentId: id } })).toBe(0);

    const charge = await api().post(`/api/v1/appointments/${id}/no-show/charge`).set(as(tokenA));
    expect(charge.status).toBe(201);
    expect(charge.body.session).toMatchObject({ kind: 'falta', billingEligibility: 'elegivel' });
    const decisions = await db.appointmentDecision.findMany({ where: { appointmentId: id } });
    expect(decisions.map((d) => [d.decision, d.decidedByUserId])).toEqual([['cobranca_de_falta_confirmada', adminUserId]]);
    const billing = await createBilling([charge.body.session.id]);
    expect(billing.status).toBe(201);
    clinicA.billingIds.push(billing.body.id);

    const excuse = await api().post(`/api/v1/appointments/${id}/no-show/excuse`).set(as(tokenA)).send({ reason: 'tarde demais' });
    expect([excuse.status, excuse.body.error.code]).toEqual([409, 'NO_SHOW_DECISION_CLOSED']);
  });

  it('abono exige motivo; o motivo fica no histórico de decisões e nunca na auditoria; a reversão volta à decisão humana', async () => {
    const id = await book(uniquePastSlot());
    await api().post(`/api/v1/appointments/${id}/no-show`).set(as(tokenA));
    const withoutReason = await api().post(`/api/v1/appointments/${id}/no-show/excuse`).set(as(tokenA)).send({});
    expect([withoutReason.status, withoutReason.body.error.code]).toEqual([400, 'REASON_REQUIRED']);

    const excused = await api().post(`/api/v1/appointments/${id}/no-show/excuse`).set(as(tokenA)).send({ reason: 'atestado-sigiloso-K2B' });
    expect(excused.body.outcome.outcome).toBe('FaltaAbonada');
    const reverted = await api().post(`/api/v1/appointments/${id}/no-show/excuse/revert`).set(as(tokenA)).send({ reason: 'revisao-sigilosa-K2B' });
    expect(reverted.body.outcome).toMatchObject({ outcome: 'Falta', noShowDecision: 'aguardando_decisao' });
    expect(await db.session.count({ where: { appointmentId: id } })).toBe(0);

    const decisions = await db.appointmentDecision.findMany({ where: { appointmentId: id }, orderBy: { decidedAt: 'asc' } });
    expect(decisions.map((d) => [d.decision, d.reason])).toEqual([
      ['falta_abonada', 'atestado-sigiloso-K2B'],
      ['abono_revertido', 'revisao-sigilosa-K2B'],
    ]);
    const audit = await auditOf(id);
    expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining(['FaltaRegistrada', 'FaltaAbonada', 'AbonoRevertido']));
    expect(audit.every((row) => row.actorType === 'user' && row.userId === adminUserId)).toBe(true);
    expect(JSON.stringify(audit)).not.toMatch(/sigilos[ao]-K2B/);
  });
});

describe('[CRÍTICO — K2-b] remarcação com histórico e cancelamento com quem pediu', () => {
  it('remarcar preserva a ocorrência anterior (horário original, desfecho Remarcada, comunicação) e liga a nova', async () => {
    const original = uniqueSlot();
    const id = await book(original);
    await api().post(`/api/v1/appointments/${id}/confirm`).set(as(tokenA));
    const target = uniqueSlot();
    const res = await api().patch(`/api/v1/appointments/${id}/reschedule`).set(as(tokenA)).send({ newScheduledAt: target, requestedBy: 'paciente', reason: 'viagem-K2B' });
    expect(res.status).toBe(200);
    clinicA.appointmentIds.push(res.body.current.id);

    const previous = await db.appointment.findUniqueOrThrow({ where: { id } });
    expect([previous.state, previous.scheduledAt.toISOString()]).toEqual(['Cancelada', original]);
    const outcome = await db.appointmentOutcomeRecord.findUniqueOrThrow({ where: { appointmentId: id } });
    expect([outcome.outcome, outcome.stateAtOutcome, outcome.scheduledAtAtOutcome.toISOString(), outcome.closingNoticeTiming]).toEqual([
      'Remarcada',
      'Cancelada',
      original,
      'no_prazo',
    ]);
    const notice = await db.appointmentNotice.findUniqueOrThrow({ where: { id: outcome.closingNoticeId as string } });
    expect([notice.channel, notice.intent, notice.requestedBy, notice.recordedByUserId, notice.referenceSource, notice.limitHoursApplied, notice.reason]).toEqual([
      'painel',
      'pedido_remarcacao',
      'paciente',
      adminUserId,
      'registro_no_painel',
      48,
      'viagem-K2B',
    ]);
    const current = await db.appointment.findUniqueOrThrow({ where: { id: res.body.current.id } });
    expect([current.state, current.scheduledAt.toISOString(), current.rescheduledFromId]).toEqual(['Reservada', target, id]);
    // O horário original ficou livre.
    await book(original);
    expect(JSON.stringify(await auditOf(id))).not.toContain('viagem-K2B');
  });

  it('cancelamento fora do prazo pedido pelo paciente abre decisão de consequência; pedido da clínica não (DP-22, DP-25)', async () => {
    // Amanhã às 10:00 e às 12:00 da clínica: sempre no futuro e a menos de 48 h
    // (o limite da clínica A), a qualquer hora em que o teste rode, e dentro da
    // janela do terapeuta. Horário relativo ao relógio (agora + 7 h) passava da
    // meia-noite da clínica à tarde e o agendamento era recusado (409).
    const patientRequest = await book(clinicTimeAt(1, 10).toISOString());
    const clinicRequest = await book(clinicTimeAt(1, 12).toISOString());
    await api().post(`/api/v1/appointments/${patientRequest}/cancel`).set(as(tokenA)).send({ requestedBy: 'paciente' });
    await api().post(`/api/v1/appointments/${clinicRequest}/cancel`).set(as(tokenA)).send({ requestedBy: 'clinica' });
    const byPatient = await db.appointmentOutcomeRecord.findUniqueOrThrow({ where: { appointmentId: patientRequest } });
    const byClinic = await db.appointmentOutcomeRecord.findUniqueOrThrow({ where: { appointmentId: clinicRequest } });
    expect([byPatient.closingNoticeTiming, byPatient.lateNoticeDecision]).toEqual(['fora_do_prazo', 'aguardando_decisao']);
    expect([byClinic.closingNoticeTiming, byClinic.lateNoticeDecision]).toEqual(['fora_do_prazo', null]);
    // Nenhum item faturável nasce de cancelamento nesta fase.
    expect(await db.session.count({ where: { appointmentId: { in: [patientRequest, clinicRequest] } } })).toBe(0);
  });

  it('consulta cancelada não recebe realização nem falta', async () => {
    const id = await book(uniqueSlot());
    await api().post(`/api/v1/appointments/${id}/cancel`).set(as(tokenA)).send({ requestedBy: 'paciente' });
    const attended = await api().post(`/api/v1/appointments/${id}/attended`).set(as(tokenA));
    expect(attended.status).toBe(409);
  });
});

describe('[CRÍTICO — K2-b] concorrência e isolamento entre clínicas', () => {
  it('realização e falta ao mesmo tempo: um desfecho só, a outra ação 409', async () => {
    const id = await book(uniquePastSlot());
    const results = await Promise.all([
      api().post(`/api/v1/appointments/${id}/attended`).set(as(tokenA)),
      api().post(`/api/v1/appointments/${id}/no-show`).set(as(tokenA)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db.appointmentOutcomeRecord.count({ where: { appointmentId: id } })).toBe(1);
    const outcome = await db.appointmentOutcomeRecord.findUniqueOrThrow({ where: { appointmentId: id } });
    expect(await db.session.count({ where: { appointmentId: id } })).toBe(outcome.outcome === 'Realizada' ? 1 : 0);
  });

  it('duas remarcações ao mesmo tempo: uma passa, a outra é recusada sem deixar ocorrência a mais', async () => {
    const id = await book(uniqueSlot());
    const results = await Promise.all([
      api().patch(`/api/v1/appointments/${id}/reschedule`).set(as(tokenA)).send({ newScheduledAt: uniqueSlot(), requestedBy: 'paciente' }),
      api().patch(`/api/v1/appointments/${id}/reschedule`).set(as(tokenA)).send({ newScheduledAt: uniqueSlot(), requestedBy: 'paciente' }),
    ]);
    for (const r of results) if (r.status === 200) clinicA.appointmentIds.push(r.body.current.id);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.appointment.count({ where: { rescheduledFromId: id } })).toBe(1);
    expect(await db.appointmentNotice.count({ where: { appointmentId: id } })).toBe(1);
  });

  it('outra clínica não registra desfecho, não decide e não lê o desfecho desta', async () => {
    const id = await book(uniquePastSlot());
    for (const path of ['attended', 'no-show']) {
      expect((await api().post(`/api/v1/appointments/${id}/${path}`).set(as(tokenB))).status).toBe(404);
    }
    await api().post(`/api/v1/appointments/${id}/no-show`).set(as(tokenA));
    expect((await api().post(`/api/v1/appointments/${id}/no-show/charge`).set(as(tokenB))).status).toBe(404);
    // Pela RLS, o papel da aplicação na clínica B não vê o desfecho, as decisões nem as comunicações da A.
    const visibleToB = await appDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${clinicB.tenantId}'`);
      return tx.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT (SELECT count(*) FROM appointment_outcome WHERE appointment_id = $1) + (SELECT count(*) FROM appointment_notice WHERE tenant_id = $2) + (SELECT count(*) FROM appointment_decision WHERE tenant_id = $2) AS n`,
        id,
        clinicA.tenantId,
      );
    });
    expect(Number(visibleToB[0].n)).toBe(0);
  });
});

describe('[CRÍTICO — K2-b] o banco congela a consulta com desfecho, para qualquer versão', () => {
  async function frozenAppointment(): Promise<{ id: string; scheduledAt: Date }> {
    const id = await book(uniquePastSlot());
    expect((await api().post(`/api/v1/appointments/${id}/no-show`).set(as(tokenA))).status).toBe(201);
    return { id, scheduledAt: (await db.appointment.findUniqueOrThrow({ where: { id } })).scheduledAt };
  }

  it('versão anterior (upsert com ON CONFLICT DO UPDATE): confirmar, cancelar ou remarcar no lugar é recusado; nada gravado', async () => {
    const { id, scheduledAt } = await frozenAppointment();
    const t = clinicA.tenantId;
    for (const [state, when] of [
      ['Confirmada', scheduledAt],
      ['Cancelada', scheduledAt],
      ['Reagendada', new Date(scheduledAt.getTime() + 3_600_000)],
    ] as const) {
      expect(await sqlStateOf(asApp(t, OLD_VERSION_APPOINTMENT_UPSERT, id, t, clinicA.patientId, clinicA.therapistId, when.toISOString(), state))).toBe('42501');
    }
    const after = await db.appointment.findUniqueOrThrow({ where: { id } });
    expect([after.state, after.scheduledAt.toISOString()]).toEqual(['Reservada', scheduledAt.toISOString()]);
  });

  it('UPDATE comum do papel da aplicação: a linha fica fora do alcance (0 linhas), em qualquer coluna', async () => {
    const { id } = await frozenAppointment();
    const t = clinicA.tenantId;
    expect(await asApp(t, `UPDATE "public"."appointment" SET "state" = 'Cancelada' WHERE "id" = $1`, id)).toBe(0);
    expect(await asApp(t, `UPDATE "public"."appointment" SET "recurring" = true WHERE "id" = $1`, id)).toBe(0);
    expect((await db.appointment.findUniqueOrThrow({ where: { id } })).recurring).toBe(false);
  });

  it('nem o superusuário muda estado, horário ou modalidade, nem apaga a consulta (chave do retrato, 23503)', async () => {
    const { id } = await frozenAppointment();
    for (const sql of [
      `UPDATE "public"."appointment" SET "state" = 'Cancelada' WHERE "id" = $1`,
      `UPDATE "public"."appointment" SET "scheduled_at" = "scheduled_at" + interval '1 hour' WHERE "id" = $1`,
      `UPDATE "public"."appointment" SET "modality" = 'online' WHERE "id" = $1`,
      `DELETE FROM "public"."appointment" WHERE "id" = $1`,
    ]) {
      expect(await sqlStateOf(db.$executeRawUnsafe(sql, id))).toBe('23503');
    }
  });

  it('o papel da aplicação não apaga o desfecho nem reescreve o retrato; muda só desfecho e decisões', async () => {
    const { id } = await frozenAppointment();
    const t = clinicA.tenantId;
    const attempts = [
      `DELETE FROM "public"."appointment_outcome" WHERE "appointment_id" = $1`,
      `UPDATE "public"."appointment_outcome" SET "state_at_outcome" = 'Cancelada' WHERE "appointment_id" = $1`,
      `UPDATE "public"."appointment_outcome" SET "scheduled_at_at_outcome" = now() WHERE "appointment_id" = $1`,
      `UPDATE "public"."appointment_outcome" SET "outcome_recorded_by_user_id" = 'outro' WHERE "appointment_id" = $1`,
      `UPDATE "public"."appointment_outcome" SET "tenant_id" = 'outra' WHERE "appointment_id" = $1`,
      `TRUNCATE "public"."appointment_outcome"`,
    ];
    for (const sql of attempts) expect(await sqlStateOf(asApp(t, sql, id))).toBe('42501');
    expect(await db.appointmentOutcomeRecord.count({ where: { appointmentId: id } })).toBe(1);
  });

  it('a remarcação só passa na ordem do banco: desfecho Remarcada com a consulta ainda aberta é recusado', async () => {
    const id = await book(uniqueSlot());
    const t = clinicA.tenantId;
    const noticeId = randomUUID();
    const now = new Date();
    const appointment = await db.appointment.findUniqueOrThrow({ where: { id } });
    await asApp(
      t,
      `INSERT INTO "public"."appointment_notice" ("id","tenant_id","appointment_id","patient_id","channel","recorded_at","reference_time","reference_source","timing","minutes_from_start","intent","intent_source","requested_by","recorded_by_user_id","recorded_by_actor_type","review_status")
       VALUES ($1, $2, $3, $4, 'painel', $5::timestamp, $5::timestamp, 'registro_no_painel', 'sem_limite_configurado', 100, 'pedido_remarcacao', 'pessoa', 'paciente', 'u1', 'user', 'sem_revisao_necessaria')`,
      noticeId,
      t,
      id,
      clinicA.patientId,
      now.toISOString(),
    );
    const insertOutcome = (state: string) =>
      asApp(
        t,
        `INSERT INTO "public"."appointment_outcome" ("appointment_id","tenant_id","outcome","outcome_recorded_by_user_id","state_at_outcome","scheduled_at_at_outcome","modality_at_outcome","closing_notice_id","closing_notice_timing")
         VALUES ($1, $2, 'Remarcada', 'u1', CAST($3::text AS "public"."AppointmentState"), $4::timestamp, 'presencial', $5, 'sem_limite_configurado')`,
        id,
        t,
        state,
        appointment.scheduledAt.toISOString(),
        noticeId,
      );
    // Ordem invertida: o retrato "Cancelada" não existe enquanto a consulta está Reservada.
    expect(await sqlStateOf(insertOutcome('Cancelada'))).toBe('23503');
    // E o CHECK não deixa o Remarcada com o retrato aberto.
    expect(await sqlStateOf(insertOutcome('Reservada'))).toBe('23514');
    expect(await db.appointmentOutcomeRecord.count({ where: { appointmentId: id } })).toBe(0);
  });
});

describe('[CRÍTICO — K2-b] o banco confere a elegibilidade do vínculo, para qualquer versão', () => {
  const billingInsert = `INSERT INTO "public"."billing" ("id","tenant_id","patient_id","amount","status","due_date","created_at","updated_at","eligibility_protocol")
    VALUES ($1, $2, $3, 400, 'criada', '2026-12-10', now(), now(), 'billing-eligibility-v1')`;
  const linkInsert = `INSERT INTO "public"."billing_session" ("id","tenant_id","billing_id","session_id","created_at","patient_id") VALUES ($1, $2, $3, $4, now(), $5)`;

  it('versão com o protocolo (fb93885) cobrando sessão legada: o vínculo é recusado e a transação desfeita, sem cobrança órfã', async () => {
    const id = await book(uniquePastSlot());
    const legacy = await legacySessionFor(id);
    const billingId = randomUUID();
    const t = clinicA.tenantId;
    const state = await sqlStateOf(
      asAppInTransaction(t, [
        [billingInsert, billingId, t, clinicA.patientId],
        [linkInsert, randomUUID(), t, billingId, legacy, clinicA.patientId],
      ]),
    );
    expect(state).toBe('23503');
    expect(await db.billing.count({ where: { id: billingId } })).toBe(0);
    expect(await db.billingSession.count({ where: { sessionId: legacy } })).toBe(0);
  });

  it('vínculo novo sem a elegibilidade exigida, ou exigindo não elegível: recusado (CHECK)', async () => {
    const { sessionId } = await attendedSession(app, tokenA, { patientId: clinicA.patientId, therapistId: clinicA.therapistId });
    clinicA.sessionIds.push(sessionId);
    const billingId = randomUUID();
    const t = clinicA.tenantId;
    await asApp(t, billingInsert, billingId, t, clinicA.patientId);
    clinicA.billingIds.push(billingId);
    const explicit = `INSERT INTO "public"."billing_session" ("id","tenant_id","billing_id","session_id","patient_id","required_eligibility") VALUES ($1, $2, $3, $4, $5, $6::"BillingEligibility")`;
    expect(await sqlStateOf(asApp(t, explicit, randomUUID(), t, billingId, sessionId, clinicA.patientId, null))).toBe('23514');
    expect(await sqlStateOf(asApp(t, explicit, randomUUID(), t, billingId, sessionId, clinicA.patientId, 'nao_elegivel'))).toBe('23514');
    expect(await sqlStateOf(asApp(t, `INSERT INTO "public"."billing_session" ("id","tenant_id","billing_id","session_id","patient_id","legacy_eligibility_link") VALUES ($1, $2, $3, $4, $5, true)`, randomUUID(), t, billingId, sessionId, clinicA.patientId))).toBe('42501');
    expect(await db.billingSession.count({ where: { sessionId } })).toBe(0);
  });

  it('sessão vinculada não deixa de ser elegível, nem para o superusuário', async () => {
    const { sessionId } = await attendedSession(app, tokenA, { patientId: clinicA.patientId, therapistId: clinicA.therapistId });
    clinicA.sessionIds.push(sessionId);
    const billing = await createBilling([sessionId]);
    expect(billing.status).toBe(201);
    clinicA.billingIds.push(billing.body.id);
    expect(await sqlStateOf(db.$executeRawUnsafe(`UPDATE "public"."session" SET "billing_eligibility" = 'nao_elegivel' WHERE "id" = $1`, sessionId))).toBe('23503');
  });

  it('sessão só é elegível com kind e sem anulação (CHECK); sessão nova de versão anterior nasce não elegível', async () => {
    const id = await book(uniquePastSlot());
    const legacy = await legacySessionFor(id);
    const t = clinicA.tenantId;
    expect(await sqlStateOf(asApp(t, `UPDATE "public"."session" SET "billing_eligibility" = 'elegivel' WHERE "id" = $1`, legacy))).toBe('23514');
    expect(
      await sqlStateOf(asApp(t, `UPDATE "public"."session" SET "billing_eligibility" = 'elegivel', "kind" = 'atendimento', "voided_at" = now(), "void_reason" = 'desfecho_corrigido' WHERE "id" = $1`, legacy)),
    ).toBe('23514');
    // A versão anterior continua passando a sessão de estado (o upsert dela não toca nas colunas novas).
    expect(await asApp(t, OLD_VERSION_SESSION_UPSERT, legacy, t, id, clinicA.patientId, clinicA.therapistId, 'Realizada')).toBe(1);
    expect(await db.session.findUniqueOrThrow({ where: { id: legacy } })).toMatchObject({ billingEligibility: 'nao_elegivel', kind: null });
  });

  it('a versão anterior continua agendando, confirmando e cancelando consulta SEM desfecho (modo degradado compatível)', async () => {
    const id = randomUUID();
    const when = new Date(uniqueSlot());
    const t = clinicA.tenantId;
    for (const state of ['Reservada', 'Confirmada', 'Cancelada']) {
      expect(await asApp(t, OLD_VERSION_APPOINTMENT_UPSERT, id, t, clinicA.patientId, clinicA.therapistId, when.toISOString(), state)).toBe(1);
    }
    clinicA.appointmentIds.push(id);
    expect((await db.appointment.findUniqueOrThrow({ where: { id } })).state).toBe('Cancelada');
  });
});

describe('[CRÍTICO — K2-b] comunicação e decisões são somente de acréscimo', () => {
  it('o papel da aplicação não reescreve horários nem origem da comunicação, nem apaga; não muda nem apaga decisão', async () => {
    const id = await book(uniqueSlot());
    await api().post(`/api/v1/appointments/${id}/cancel`).set(as(tokenA)).send({ requestedBy: 'paciente' });
    const notice = await db.appointmentNotice.findFirstOrThrow({ where: { appointmentId: id } });
    const t = clinicA.tenantId;
    for (const sql of [
      `UPDATE "public"."appointment_notice" SET "reference_time" = now(), "recorded_at" = now() WHERE "id" = $1`,
      `UPDATE "public"."appointment_notice" SET "requested_by" = 'clinica' WHERE "id" = $1`,
      `UPDATE "public"."appointment_notice" SET "timing" = 'no_prazo' WHERE "id" = $1`,
      `DELETE FROM "public"."appointment_notice" WHERE "id" = $1`,
    ]) {
      expect(await sqlStateOf(asApp(t, sql, notice.id))).toBe('42501');
    }

    const past = await book(uniquePastSlot());
    await api().post(`/api/v1/appointments/${past}/no-show`).set(as(tokenA));
    await api().post(`/api/v1/appointments/${past}/no-show/excuse`).set(as(tokenA)).send({ reason: 'motivo' });
    const decision = await db.appointmentDecision.findFirstOrThrow({ where: { appointmentId: past } });
    for (const sql of [
      `UPDATE "public"."appointment_decision" SET "reason" = 'outro' WHERE "id" = $1`,
      `UPDATE "public"."appointment_decision" SET "decision" = 'abono_revertido' WHERE "id" = $1`,
      `DELETE FROM "public"."appointment_decision" WHERE "id" = $1`,
    ]) {
      expect(await sqlStateOf(asApp(t, sql, decision.id))).toBe('42501');
    }
  });
});

describe('[CRÍTICO — K2-b] guarda de CI: as proteções continuam no banco', () => {
  it('todas as restrições da K2-b existem e estão validadas', async () => {
    const rows = await db.$queryRawUnsafe<Array<{ conname: string; convalidated: boolean }>>(
      `SELECT conname, convalidated FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname = ANY($1::text[])`,
      K2B_CONSTRAINTS,
    );
    expect(rows.map((row) => row.conname).sort()).toEqual([...K2B_CONSTRAINTS].sort());
    expect(rows.every((row) => row.convalidated)).toBe(true);
  });

  it('a política de congelamento é RESTRICTIVE, de UPDATE, para o papel da aplicação; nenhuma permissiva nova em appointment', async () => {
    const policies = await db.$queryRawUnsafe<Array<{ polname: string; polpermissive: boolean; polcmd: string; roles: string }>>(
      `SELECT polname, polpermissive, polcmd, array_to_string(ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(polroles)), ',') AS roles
         FROM pg_policy WHERE polrelid = 'public.appointment'::regclass ORDER BY polname`,
    );
    expect(policies).toEqual([
      { polname: 'appointment_frozen_after_outcome', polpermissive: false, polcmd: 'w', roles: 'luxora_app' },
      { polname: 'tenant_isolation', polpermissive: true, polcmd: '*', roles: '' },
    ]);
  });

  it('RLS habilitada e forçada nas tabelas novas', async () => {
    const rows = await db.$queryRawUnsafe<Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('appointment_outcome', 'appointment_notice', 'appointment_decision') ORDER BY relname`,
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });

  it('o banco exige appointment-outcome-v1; o papel da aplicação tem só os privilégios previstos nas tabelas novas', async () => {
    expect((await db.deploymentRequirement.findMany()).map((row) => row.capability).sort()).toEqual(['appointment-outcome-v1', 'billing-eligibility-v1']);
    const rows = await db.$queryRawUnsafe<Array<{ grant: string; owner: string }>>(
      `SELECT c.relname || '.' || a.attname || ':' || p.priv AS "grant", pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        CROSS JOIN unnest(ARRAY['UPDATE']) AS p(priv)
        WHERE c.relnamespace = 'public'::regnamespace
          AND c.relname IN ('appointment_outcome', 'appointment_notice', 'appointment_decision')
          AND has_column_privilege('luxora_app', c.oid, a.attnum, p.priv)
        ORDER BY 1`,
    );
    const appOwnsTables = rows.length > 0 && rows.every((row) => row.owner === 'luxora_app');
    expect(rows.map((row) => row.grant).sort()).toEqual(
      [
        ...(appOwnsTables ? ['appointment_decision.decided_at:UPDATE'] : []),
        ...['outcome', 'no_show_decision', 'no_show_decision_at', 'no_show_decision_by_user_id', 'late_notice_decision', 'late_notice_decision_at', 'late_notice_decision_by_user_id'].map(
          (c) => `appointment_outcome.${c}:UPDATE`,
        ),
        ...['review_status', 'reviewed_by_user_id', 'reviewed_at'].map((c) => `appointment_notice.${c}:UPDATE`),
      ].sort(),
    );
    const tablePrivileges = await db.$queryRawUnsafe<Array<{ t: string; del: boolean; trunc: boolean }>>(
      `SELECT t, has_table_privilege('luxora_app', 'public.' || t, 'DELETE') AS del, has_table_privilege('luxora_app', 'public.' || t, 'TRUNCATE') AS trunc
         FROM unnest(ARRAY['appointment_outcome', 'appointment_notice', 'appointment_decision']) AS t`,
    );
    expect(tablePrivileges.every((row) => !row.del && !row.trunc)).toBe(true);
    expect(
      (
        await db.$queryRawUnsafe<Array<{ ins: boolean }>>(`SELECT has_column_privilege('luxora_app', 'public.billing_session', 'legacy_eligibility_link', 'INSERT,UPDATE') AS ins`)
      )[0].ins,
    ).toBe(false);
  });
});
