import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, UserRole } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { uniqueSlot } from './support/unique-slot';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * [CRÍTICO — Tarefa 05 da auditoria] Rotas de leitura que o painel precisa
 * para operar sem chamada manual à API:
 *
 *   GET /sessions                               sessões a cobrar
 *   GET /billings/:id/payments                  pagamento de uma cobrança (para o estorno)
 *   GET /therapists/:id/availability/calendar   disponibilidade já gravada
 *
 * São só leitura, mas expõem dado clínico e financeiro: o que importa
 * provar é que exigem sessão e que uma clínica nunca lê o que é de outra.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let clinicA: DedicatedFixture;
let clinicB: DedicatedFixture;
let tokenA: string;
let tokenB: string;
let therapistTokenA: string;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

const api = () => request(app.getHttpServer());
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createConfirmedSession(): Promise<{ sessionId: string; scheduledAt: string }> {
  const scheduledAt = uniqueSlot();
  const appointment = await api()
    .post('/api/v1/appointments')
    .set(as(tokenA))
    .send({ patientId: clinicA.patientId, therapistId: clinicA.therapistId, scheduledAt, modality: 'presencial' });
  expect(appointment.status).toBe(201);
  clinicA.appointmentIds.push(appointment.body.id);

  const confirm = await api().post(`/api/v1/appointments/${appointment.body.id}/confirm`).set(as(tokenA));
  expect(confirm.status).toBe(201);

  const session = await fixturePrisma.session.findUniqueOrThrow({ where: { appointmentId: appointment.body.id } });
  clinicA.sessionIds.push(session.id);
  return { sessionId: session.id, scheduledAt };
}

async function createBilling(sessionId: string): Promise<string> {
  const billing = await api()
    .post('/api/v1/billings')
    .set(as(tokenA))
    .send({ patientId: clinicA.patientId, amount: 250, dueDate: '2027-01-15', sessionIds: [sessionId] });
  expect(billing.status).toBe(201);
  clinicA.billingIds.push(billing.body.id);
  return billing.body.id;
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  app = await bootstrapTestApp();

  clinicA = await createDedicatedFixture(fixturePrisma, 'OPREADA', { withActiveSubscription: true, withAvailabilityCalendar: true });
  clinicB = await createDedicatedFixture(fixturePrisma, 'OPREADB', { withActiveSubscription: true, withAvailabilityCalendar: true });
  tokenA = await createDedicatedUserAndLogin(fixturePrisma, app, clinicA, 'OPREADA');
  tokenB = await createDedicatedUserAndLogin(fixturePrisma, app, clinicB, 'OPREADB');
  therapistTokenA = await createDedicatedUserAndLogin(fixturePrisma, app, clinicA, 'OPREADA', UserRole.therapist);
});

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, clinicA);
  await cleanupDedicatedFixture(fixturePrisma, clinicB);
  await fixturePrisma.$disconnect();
  await app.close();
});

describe('[CRÍTICO — Tarefa 05] GET /sessions', () => {
  it('exige sessão autenticada', async () => {
    expect((await api().get('/api/v1/sessions')).status).toBe(401);
  });

  it('lista a sessão criada ao confirmar a consulta, com a data da consulta', async () => {
    const { sessionId, scheduledAt } = await createConfirmedSession();

    const res = await api().get(`/api/v1/sessions?state=Realizada&patientId=${clinicA.patientId}`).set(as(tokenA));

    expect(res.status).toBe(200);
    const listed = res.body.data.find((session: { id: string }) => session.id === sessionId);
    expect(listed).toMatchObject({ patientId: clinicA.patientId, therapistId: clinicA.therapistId, state: 'Realizada' });
    expect(new Date(listed.scheduledAt).toISOString()).toBe(new Date(scheduledAt).toISOString());
  });

  it('depois de cobrada, a sessão sai de "Realizada" e passa a aparecer em "Faturada"', async () => {
    const { sessionId } = await createConfirmedSession();
    await createBilling(sessionId);

    const pending = await api().get('/api/v1/sessions?state=Realizada').set(as(tokenA));
    const billed = await api().get('/api/v1/sessions?state=Faturada').set(as(tokenA));

    expect(pending.body.data.map((session: { id: string }) => session.id)).not.toContain(sessionId);
    expect(billed.body.data.map((session: { id: string }) => session.id)).toContain(sessionId);
  });

  it('outra clínica não enxerga as sessões desta — nem pedindo pelo paciente dela', async () => {
    const { sessionId } = await createConfirmedSession();

    const all = await api().get('/api/v1/sessions').set(as(tokenB));
    const byPatient = await api().get(`/api/v1/sessions?patientId=${clinicA.patientId}`).set(as(tokenB));

    expect(all.status).toBe(200);
    expect(all.body.data.map((session: { id: string }) => session.id)).not.toContain(sessionId);
    expect(byPatient.body.data).toEqual([]);
  });

  it('o perfil terapeuta também lê (mesma regra de GET /billings)', async () => {
    expect((await api().get('/api/v1/sessions').set(as(therapistTokenA))).status).toBe(200);
  });

  it.each(['state=Inventada', 'limit=0', 'limit=abc', 'limit=201'])('recusa parâmetro inválido (%s) com 400', async (query) => {
    expect((await api().get(`/api/v1/sessions?${query}`).set(as(tokenA))).status).toBe(400);
  });
});

describe('[CRÍTICO — Tarefa 05] GET /billings/:id/payments', () => {
  it('exige sessão autenticada', async () => {
    expect((await api().get('/api/v1/billings/00000000-0000-4000-8000-000000000000/payments')).status).toBe(401);
  });

  it('acompanha o pagamento da cobrança: vazio, confirmado e, depois do estorno, estornado', async () => {
    const { sessionId } = await createConfirmedSession();
    const billingId = await createBilling(sessionId);
    const list = () => api().get(`/api/v1/billings/${billingId}/payments`).set(as(tokenA));

    expect((await list()).body).toEqual({ data: [] });

    const payment = await api()
      .post('/api/v1/payments')
      .set(as(tokenA))
      .set('Idempotency-Key', `opread-${billingId}`)
      .send({ billingId, amount: 250 });
    expect(payment.status).toBe(201);
    clinicA.paymentIds.push(payment.body.id);

    const paid = await list();
    expect(paid.body.data).toEqual([{ id: payment.body.id, billingId, amount: 250, state: 'Confirmado' }]);

    // O id que a listagem devolve é o que o estorno pede.
    const refund = await api().post(`/api/v1/payments/${paid.body.data[0].id}/refund`).set(as(tokenA));
    expect(refund.status).toBe(201);
    expect((await list()).body.data[0].state).toBe('Estornado');
  });

  it('cobrança de outra clínica responde 404 — não confirma nem que existe', async () => {
    const { sessionId } = await createConfirmedSession();
    const billingId = await createBilling(sessionId);

    const res = await api().get(`/api/v1/billings/${billingId}/payments`).set(as(tokenB));

    expect(res.status).toBe(404);
  });
});

describe('[CRÍTICO — Tarefa 05] GET /therapists/:id/availability/calendar', () => {
  it('exige sessão autenticada', async () => {
    expect((await api().get(`/api/v1/therapists/${clinicA.therapistId}/availability/calendar`)).status).toBe(401);
  });

  it('devolve as janelas já gravadas', async () => {
    const res = await api().get(`/api/v1/therapists/${clinicA.therapistId}/availability/calendar`).set(as(tokenA));

    expect(res.status).toBe(200);
    expect(res.body.therapistId).toBe(clinicA.therapistId);
    expect(res.body.windows).toHaveLength(7);
    expect(res.body.windows[0]).toMatchObject({ dayOfWeek: 0, startTime: '00:00', endTime: '23:59' });
    expect(Array.isArray(res.body.exceptions)).toBe(true);
  });

  it('reflete o que foi gravado pelas rotas de escrita, para o painel não sobrescrever às cegas', async () => {
    const exception = { from: '2031-03-10T00:00:00.000Z', to: '2031-03-12T00:00:00.000Z', reason: 'Congresso' };
    const put = await api()
      .put(`/api/v1/therapists/${clinicB.therapistId}/availability/exceptions`)
      .set(as(tokenB))
      .send({ exceptions: [exception] });
    expect(put.status).toBe(200);

    const res = await api().get(`/api/v1/therapists/${clinicB.therapistId}/availability/calendar`).set(as(tokenB));

    expect(res.body.exceptions).toHaveLength(1);
    expect(res.body.exceptions[0].reason).toBe('Congresso');
    expect(res.body.windows).toHaveLength(7);
  });

  it('404 quando o terapeuta ainda não tem calendário', async () => {
    // Direto no banco: pela API, um segundo terapeuta esbarraria no limite do plano da fixture.
    const therapist = await fixturePrisma.therapist.create({ data: { tenantId: clinicA.tenantId, name: 'Terapeuta Sem Agenda' } });
    clinicA.therapistIds.push(therapist.id);

    const res = await api().get(`/api/v1/therapists/${therapist.id}/availability/calendar`).set(as(tokenA));

    expect(res.status).toBe(404);
  });

  it('calendário de terapeuta de outra clínica responde 404', async () => {
    const res = await api().get(`/api/v1/therapists/${clinicA.therapistId}/availability/calendar`).set(as(tokenB));

    expect(res.status).toBe(404);
  });

  it('o perfil terapeuta lê, mas continua sem poder alterar', async () => {
    const read = await api().get(`/api/v1/therapists/${clinicA.therapistId}/availability/calendar`).set(as(therapistTokenA));
    const write = await api()
      .put(`/api/v1/therapists/${clinicA.therapistId}/availability/exceptions`)
      .set(as(therapistTokenA))
      .send({ exceptions: [] });

    expect(read.status).toBe(200);
    expect(write.status).toBe(403);
  });
});
