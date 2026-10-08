import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * [CRÍTICO — Tarefa 06 da auditoria, AD-032] AppointmentsController.
 *
 * Até aqui só o RBAC das rotas que alteram tinha teste
 * (rbac-mutating-routes.test.ts) e a corrida entre dois agendamentos
 * (appointment-concurrency.test.ts). Este arquivo cobre o resto do
 * contrato: acesso sem sessão, isolamento entre clínicas, validação,
 * recurso inexistente, conflitos de agenda e o ciclo da consulta.
 *
 * Horários fixos e determinísticos: as clínicas são só deste arquivo, com
 * disponibilidade o dia inteiro, então cada teste usa a sua própria hora
 * (`slot(n)`), sem sorteio.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let clinicA: DedicatedFixture;
let clinicB: DedicatedFixture;
let tokenA: string;
let tokenB: string;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

const api = () => request(app.getHttpServer());
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Hora cheia `n` horas depois de uma base 60 dias à frente — cada teste usa números próprios. */
const BASE = new Date();
BASE.setDate(BASE.getDate() + 60);
BASE.setHours(0, 0, 0, 0);
const slot = (n: number) => new Date(BASE.getTime() + n * 60 * 60 * 1000).toISOString();

const body = (n: number, overrides: Record<string, unknown> = {}) => ({
  patientId: clinicA.patientId,
  therapistId: clinicA.therapistId,
  scheduledAt: slot(n),
  modality: 'presencial',
  ...overrides,
});

async function book(n: number, token = tokenA, overrides: Record<string, unknown> = {}) {
  return api().post('/api/v1/appointments').set(as(token)).send(body(n, overrides));
}

const stored = (id: string) => fixturePrisma.appointment.findUniqueOrThrow({ where: { id } });
const countOf = (tenantId: string) => fixturePrisma.appointment.count({ where: { tenantId } });

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  app = await bootstrapTestApp();

  clinicA = await createDedicatedFixture(fixturePrisma, 'APPTCTRL-A', { withActiveSubscription: true, withAvailabilityCalendar: true });
  clinicB = await createDedicatedFixture(fixturePrisma, 'APPTCTRL-B', { withActiveSubscription: true, withAvailabilityCalendar: true });
  tokenA = await createDedicatedUserAndLogin(fixturePrisma, app, clinicA, 'APPTCTRLA');
  tokenB = await createDedicatedUserAndLogin(fixturePrisma, app, clinicB, 'APPTCTRLB');
}, 60_000);

afterAll(async () => {
  // As sessões nascem da confirmação e não têm id devolvido pela API.
  for (const fixture of [clinicA, clinicB]) {
    if (fixture) await fixturePrisma.session.deleteMany({ where: { tenantId: fixture.tenantId } });
  }
  await cleanupDedicatedFixture(fixturePrisma, clinicA);
  await cleanupDedicatedFixture(fixturePrisma, clinicB);
  await fixturePrisma.$disconnect();
  await app.close();
});

describe('[CRÍTICO — AD-032] Consultas — sem sessão', () => {
  it.each([
    ['GET', `/api/v1/appointments?from=${slot(0)}&to=${slot(24)}`],
    ['GET', `/api/v1/therapists/${randomUUID()}/availability?from=${slot(0)}&to=${slot(24)}`],
    ['POST', '/api/v1/appointments'],
    ['POST', '/api/v1/appointments/recurring'],
    ['PATCH', `/api/v1/appointments/${randomUUID()}/reschedule`],
    ['POST', `/api/v1/appointments/${randomUUID()}/cancel`],
    ['POST', `/api/v1/appointments/${randomUUID()}/confirm`],
  ])('%s %s sem token: 401', async (method, path) => {
    const res = await (api() as unknown as Record<string, (path: string) => request.Test>)[method.toLowerCase()](path).send({});

    expect(res.status).toBe(401);
  });
});

describe('[CRÍTICO — AD-032] Consultas — marcar e validar', () => {
  it('marca e devolve exatamente os campos do contrato, no estado Reservada', async () => {
    const res = await book(1);

    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['id', 'patientId', 'recurring', 'scheduledAt', 'state', 'therapistId']);
    expect(res.body).toMatchObject({ patientId: clinicA.patientId, therapistId: clinicA.therapistId, state: 'Reservada', recurring: false });
    expect(new Date(res.body.scheduledAt).toISOString()).toBe(slot(1));
    expect((await stored(res.body.id)).tenantId).toBe(clinicA.tenantId);
  });

  it.each([
    ['data que não é data', { scheduledAt: 'amanhã cedo' }],
    ['modalidade desconhecida', { modality: 'telepatia' }],
    ['sem paciente', { patientId: undefined }],
    ['sem terapeuta', { therapistId: undefined }],
    ['sem data', { scheduledAt: undefined }],
    ['recurring que não é booleano', { recurring: 'sim' }],
    ['campo que não existe no contrato', { tenantId: randomUUID() }],
    ['tentativa de escolher o estado', { state: 'Confirmada' }],
  ])('recusa %s: 400 e nada é gravado', async (_label, overrides) => {
    const before = await countOf(clinicA.tenantId);

    const res = await book(2, tokenA, overrides);

    expect(res.status).toBe(400);
    expect(await countOf(clinicA.tenantId)).toBe(before);
  });

  it('horário fora do que o terapeuta atende: 409 SLOT_NOT_AVAILABLE', async () => {
    const withoutHours = await fixturePrisma.therapist.create({ data: { tenantId: clinicA.tenantId, name: 'Terapeuta Sem Horários', specialty: 'Psicologia' } });
    clinicA.therapistIds.push(withoutHours.id);

    const res = await book(3, tokenA, { therapistId: withoutHours.id });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLOT_NOT_AVAILABLE');
  });

  it('mesmo terapeuta e mesmo horário duas vezes: a segunda é recusada e só existe uma consulta', async () => {
    const first = await book(4);
    expect(first.status).toBe(201);

    const second = await book(4);

    expect(second.status).toBe(409);
    expect(['SLOT_NOT_AVAILABLE', 'SESSION_CONFLICT']).toContain(second.body.error.code);
    expect(await fixturePrisma.appointment.count({ where: { therapistId: clinicA.therapistId, scheduledAt: new Date(slot(4)) } })).toBe(1);
  });

  it('terapeuta inexistente: recusado, nada é gravado', async () => {
    const before = await countOf(clinicA.tenantId);

    const res = await book(5, tokenA, { therapistId: randomUUID() });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await countOf(clinicA.tenantId)).toBe(before);
  });

  it('paciente inexistente: 404, nada é gravado', async () => {
    const before = await countOf(clinicA.tenantId);

    const res = await book(6, tokenA, { patientId: randomUUID() });

    expect(res.status).toBe(404);
    expect(await countOf(clinicA.tenantId)).toBe(before);
  });
});

describe('[CRÍTICO — AD-032] Consultas — isolamento entre clínicas', () => {
  it('não marca consulta para paciente de outra clínica', async () => {
    const before = await fixturePrisma.appointment.count({ where: { patientId: clinicB.patientId } });

    const res = await book(10, tokenA, { patientId: clinicB.patientId });

    expect(res.status).toBe(404);
    expect(await fixturePrisma.appointment.count({ where: { patientId: clinicB.patientId } })).toBe(before);
  });

  it('não marca consulta com terapeuta de outra clínica', async () => {
    const before = await fixturePrisma.appointment.count({ where: { therapistId: clinicB.therapistId } });

    const res = await book(11, tokenA, { therapistId: clinicB.therapistId });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await fixturePrisma.appointment.count({ where: { therapistId: clinicB.therapistId } })).toBe(before);
  });

  it('agendamento recorrente também não aceita paciente de outra clínica', async () => {
    const before = await fixturePrisma.appointment.count({ where: { patientId: clinicB.patientId } });

    const res = await api()
      .post('/api/v1/appointments/recurring')
      .set(as(tokenA))
      .send({ patientId: clinicB.patientId, therapistId: clinicA.therapistId, firstScheduledAt: slot(12), modality: 'presencial', occurrences: 2, intervalDays: 7 });

    expect(res.status).toBe(404);
    expect(await fixturePrisma.appointment.count({ where: { patientId: clinicB.patientId } })).toBe(before);
  });

  it.each([
    ['POST', '/confirm', {}],
    ['POST', '/cancel', {}],
    ['PATCH', '/reschedule', { newScheduledAt: slot(14) }],
  ])('%s %s em consulta de outra clínica: 404 e ela não muda', async (method, suffix, payload) => {
    const foreign = await api()
      .post('/api/v1/appointments')
      .set(as(tokenB))
      .send({ patientId: clinicB.patientId, therapistId: clinicB.therapistId, scheduledAt: slot(13 + ['/confirm', '/cancel', '/reschedule'].indexOf(suffix) * 30), modality: 'presencial' });
    expect(foreign.status).toBe(201);
    const before = await stored(foreign.body.id);

    const res = await (api() as unknown as Record<string, (path: string) => request.Test>)
      [method.toLowerCase()](`/api/v1/appointments/${foreign.body.id}${suffix}`)
      .set(as(tokenA))
      .send(payload);

    expect(res.status).toBe(404);
    const after = await stored(foreign.body.id);
    expect({ state: after.state, scheduledAt: after.scheduledAt.toISOString() }).toEqual({ state: before.state, scheduledAt: before.scheduledAt.toISOString() });
  });

  it('a lista e os horários livres nunca trazem dado de outra clínica', async () => {
    const mine = await book(20);
    expect(mine.status).toBe(201);

    const listB = await api().get(`/api/v1/appointments?from=${slot(0)}&to=${slot(24 * 30)}`).set(as(tokenB));
    const availabilityOfA = await api().get(`/api/v1/therapists/${clinicA.therapistId}/availability?from=${slot(0)}&to=${slot(24)}`).set(as(tokenB));

    expect(listB.status).toBe(200);
    expect(listB.body.data.map((appointment: { id: string }) => appointment.id)).not.toContain(mine.body.id);
    expect(listB.body.data.every((appointment: { therapistId: string }) => appointment.therapistId === clinicB.therapistId)).toBe(true);
    // O terapeuta da clínica A não existe para a clínica B: nenhum horário é revelado.
    expect(availabilityOfA.status).toBeLessThan(500);
    expect(availabilityOfA.body.data ?? []).toEqual([]);
  });
});

describe('[CRÍTICO — AD-032] Consultas — confirmar, remarcar, cancelar e listar', () => {
  it.each(['confirm', 'cancel'])('%s em consulta inexistente: 404', async (action) => {
    const res = await api().post(`/api/v1/appointments/${randomUUID()}/${action}`).set(as(tokenA));

    expect(res.status).toBe(404);
  });

  it('remarcar consulta inexistente: 404; com data inválida: 400', async () => {
    const missing = await api().patch(`/api/v1/appointments/${randomUUID()}/reschedule`).set(as(tokenA)).send({ newScheduledAt: slot(30) });
    const booked = await book(31);
    const invalid = await api().patch(`/api/v1/appointments/${booked.body.id}/reschedule`).set(as(tokenA)).send({ newScheduledAt: 'depois' });

    expect(missing.status).toBe(404);
    expect(invalid.status).toBe(400);
    expect((await stored(booked.body.id)).scheduledAt.toISOString()).toBe(slot(31));
  });

  it('confirmar gera exatamente uma sessão; confirmar de novo é recusado e não gera outra', async () => {
    const booked = await book(32);

    const confirmed = await api().post(`/api/v1/appointments/${booked.body.id}/confirm`).set(as(tokenA));
    const again = await api().post(`/api/v1/appointments/${booked.body.id}/confirm`).set(as(tokenA));

    expect(confirmed.status).toBe(201);
    expect(confirmed.body.state).toBe('Confirmada');
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(await fixturePrisma.session.count({ where: { appointmentId: booked.body.id } })).toBe(1);
    expect((await stored(booked.body.id)).state).toBe('Confirmada');
  });

  it('remarcar para um horário ocupado: 409 e a consulta fica onde estava', async () => {
    const occupied = await book(33);
    const moving = await book(34);
    expect(occupied.status).toBe(201);

    const res = await api().patch(`/api/v1/appointments/${moving.body.id}/reschedule`).set(as(tokenA)).send({ newScheduledAt: slot(33) });

    expect(res.status).toBe(409);
    expect((await stored(moving.body.id)).scheduledAt.toISOString()).toBe(slot(34));
  });

  it('remarcar para um horário livre move a consulta e libera o anterior', async () => {
    const booked = await book(35);

    const res = await api().patch(`/api/v1/appointments/${booked.body.id}/reschedule`).set(as(tokenA)).send({ newScheduledAt: slot(36) });

    expect(res.status).toBe(200);
    expect(new Date(res.body.scheduledAt).toISOString()).toBe(slot(36));
    expect((await book(35)).status).toBe(201); // o horário antigo voltou a estar livre
  });

  it('cancelar libera o horário; consulta cancelada não é confirmada nem cancelada de novo', async () => {
    const booked = await book(37);

    const cancelled = await api().post(`/api/v1/appointments/${booked.body.id}/cancel`).set(as(tokenA));
    expect(cancelled.status).toBe(201);
    expect(cancelled.body.state).toBe('Cancelada');

    expect((await book(37)).status).toBe(201);
    const confirm = await api().post(`/api/v1/appointments/${booked.body.id}/confirm`).set(as(tokenA));
    const cancelAgain = await api().post(`/api/v1/appointments/${booked.body.id}/cancel`).set(as(tokenA));
    expect(confirm.status).toBeGreaterThanOrEqual(400);
    expect(cancelAgain.status).toBeGreaterThanOrEqual(400);
    expect((await stored(booked.body.id)).state).toBe('Cancelada');
  });

  it('a lista respeita o intervalo pedido e não traz consulta cancelada', async () => {
    const inside = await book(40);
    const outside = await book(24 * 20);
    const cancelled = await book(41);
    await api().post(`/api/v1/appointments/${cancelled.body.id}/cancel`).set(as(tokenA));

    const res = await api().get(`/api/v1/appointments?from=${slot(39)}&to=${slot(42)}`).set(as(tokenA));

    expect(res.status).toBe(200);
    const ids = res.body.data.map((appointment: { id: string }) => appointment.id);
    expect(ids).toContain(inside.body.id);
    expect(ids).not.toContain(outside.body.id);
    expect(ids).not.toContain(cancelled.body.id);
  });

  it.each([
    ['sem from e to', ''],
    ['from que não é data', `?from=ontem&to=${slot(24)}`],
    ['to que não é data', `?from=${slot(0)}&to=amanha`],
  ])('lista %s: 400, não erro interno', async (_label, query) => {
    const res = await api().get(`/api/v1/appointments${query}`).set(as(tokenA));

    expect(res.status).toBe(400);
  });

  it.each([
    ['sem from e to', ''],
    ['from que não é data', `?from=ontem&to=${slot(24)}`],
  ])('horários livres %s: 400, não erro interno', async (_label, query) => {
    const res = await api().get(`/api/v1/therapists/${clinicA.therapistId}/availability${query}`).set(as(tokenA));

    expect(res.status).toBe(400);
  });
});

describe('[CRÍTICO — AD-032] Consultas — recorrência', () => {
  it('cria as ocorrências pedidas, no intervalo pedido', async () => {
    const res = await api()
      .post('/api/v1/appointments/recurring')
      .set(as(tokenA))
      .send({ patientId: clinicA.patientId, therapistId: clinicA.therapistId, firstScheduledAt: slot(50), modality: 'online', occurrences: 3, intervalDays: 7 });

    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(3);
    const times = res.body.data.map((appointment: { scheduledAt: string }) => new Date(appointment.scheduledAt).getTime());
    expect(times[1] - times[0]).toBe(7 * 24 * 60 * 60 * 1000);
    expect(res.body.data.every((appointment: { recurring: boolean }) => appointment.recurring)).toBe(true);
  });

  it.each([
    ['zero ocorrências', { occurrences: 0 }],
    ['intervalo zero', { intervalDays: 0 }],
    ['ocorrências fracionadas', { occurrences: 1.5 }],
    ['primeira data inválida', { firstScheduledAt: 'logo' }],
  ])('recusa %s: 400 e nada é gravado', async (_label, overrides) => {
    const before = await countOf(clinicA.tenantId);

    const res = await api()
      .post('/api/v1/appointments/recurring')
      .set(as(tokenA))
      .send({ patientId: clinicA.patientId, therapistId: clinicA.therapistId, firstScheduledAt: slot(60), modality: 'presencial', occurrences: 2, intervalDays: 7, ...overrides });

    expect(res.status).toBe(400);
    expect(await countOf(clinicA.tenantId)).toBe(before);
  });
});
