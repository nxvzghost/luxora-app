import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * [CRÍTICO — Tarefa 06 da auditoria] Nenhum registro de uma clínica pode
 * apontar para paciente ou terapeuta de outra.
 *
 * ACHADO REAL dos testes de AD-032: as rotas que recebem `patientId` (e
 * `therapistId`) no corpo gravavam o que viesse. A RLS impede LER dado de
 * outra clínica, mas as chaves estrangeiras não olham a clínica: com o id
 * de um paciente alheio, a consulta, o horário fixo ou a cobrança eram
 * gravados nesta clínica apontando para ele. A consulta está em
 * appointments-controller.test.ts; aqui, o horário fixo e a cobrança.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let clinicA: DedicatedFixture;
let clinicB: DedicatedFixture;
let tokenA: string;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

const api = () => request(app.getHttpServer());
const auth = () => ({ Authorization: `Bearer ${tokenA}` });

const FIRST = new Date();
FIRST.setDate(FIRST.getDate() + 60);
FIRST.setHours(10, 0, 0, 0);

const blockBody = (overrides: Record<string, unknown> = {}) => ({
  patientId: clinicA.patientId,
  therapistId: clinicA.therapistId,
  firstOccurrence: FIRST.toISOString(),
  intervalDays: 7,
  modality: 'presencial',
  renewalMode: 'manual',
  ...overrides,
});

/** Uma sessão a cobrar na clínica A, criada pela API (consulta marcada e confirmada). */
async function billableSession(hourOffset: number): Promise<string> {
  const scheduledAt = new Date(FIRST.getTime() + hourOffset * 60 * 60 * 1000).toISOString();
  const appointment = await api()
    .post('/api/v1/appointments')
    .set(auth())
    .send({ patientId: clinicA.patientId, therapistId: clinicA.therapistId, scheduledAt, modality: 'presencial' });
  expect(appointment.status).toBe(201);
  expect((await api().post(`/api/v1/appointments/${appointment.body.id}/confirm`).set(auth())).status).toBe(201);
  const session = await fixturePrisma.session.findUniqueOrThrow({ where: { appointmentId: appointment.body.id } });
  clinicA.sessionIds.push(session.id);
  return session.id;
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  app = await bootstrapTestApp();

  clinicA = await createDedicatedFixture(fixturePrisma, 'XCLINIC-A', { withActiveSubscription: true, withAvailabilityCalendar: true });
  clinicB = await createDedicatedFixture(fixturePrisma, 'XCLINIC-B', { withActiveSubscription: true, withAvailabilityCalendar: true });
  tokenA = await createDedicatedUserAndLogin(fixturePrisma, app, clinicA, 'XCLINICA');
}, 60_000);

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, clinicA);
  await cleanupDedicatedFixture(fixturePrisma, clinicB);
  await fixturePrisma.$disconnect();
  await app.close();
});

describe('[CRÍTICO — Tarefa 06] Horário fixo não aponta para outra clínica', () => {
  it('com paciente e terapeuta da própria clínica, cria', async () => {
    const res = await api().post('/api/v1/recurring-blocks').set(auth()).send(blockBody());

    expect(res.status).toBe(201);
  });

  it('paciente de outra clínica: 404 e nada é gravado', async () => {
    const res = await api().post('/api/v1/recurring-blocks').set(auth()).send(blockBody({ patientId: clinicB.patientId }));

    expect(res.status).toBe(404);
    expect(await fixturePrisma.recurringBlock.count({ where: { patientId: clinicB.patientId } })).toBe(0);
  });

  it('terapeuta de outra clínica: 404 e nada é gravado', async () => {
    const res = await api().post('/api/v1/recurring-blocks').set(auth()).send(blockBody({ therapistId: clinicB.therapistId }));

    expect(res.status).toBe(404);
    expect(await fixturePrisma.recurringBlock.count({ where: { therapistId: clinicB.therapistId } })).toBe(0);
  });
});

describe('[CRÍTICO — Tarefa 06] Cobrança não aponta para outra clínica', () => {
  it('paciente de outra clínica: 404; nem a cobrança é gravada, nem a sessão deixa de estar a cobrar', async () => {
    const sessionId = await billableSession(1);

    const res = await api()
      .post('/api/v1/billings')
      .set(auth())
      .send({ patientId: clinicB.patientId, amount: 300, dueDate: '2031-02-10', sessionIds: [sessionId] });

    expect(res.status).toBe(404);
    expect(await fixturePrisma.billing.count({ where: { patientId: clinicB.patientId } })).toBe(0);
    expect((await fixturePrisma.session.findUniqueOrThrow({ where: { id: sessionId } })).state).toBe('Realizada');
  });

  it('sessão de outra clínica: recusada, e a sessão dela não muda', async () => {
    const foreign = await fixturePrisma.appointment.create({
      data: { tenantId: clinicB.tenantId, patientId: clinicB.patientId, therapistId: clinicB.therapistId, scheduledAt: new Date(FIRST.getTime() + 5 * 60 * 60 * 1000), modality: 'presencial', state: 'Confirmada' },
    });
    const foreignSession = await fixturePrisma.session.create({
      data: { tenantId: clinicB.tenantId, appointmentId: foreign.id, patientId: clinicB.patientId, therapistId: clinicB.therapistId, state: 'Realizada' },
    });
    clinicB.sessionIds.push(foreignSession.id);

    const res = await api()
      .post('/api/v1/billings')
      .set(auth())
      .send({ patientId: clinicA.patientId, amount: 300, dueDate: '2031-02-10', sessionIds: [foreignSession.id] });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await fixturePrisma.session.findUniqueOrThrow({ where: { id: foreignSession.id } })).state).toBe('Realizada');
    expect(await fixturePrisma.billingSession.count({ where: { sessionId: foreignSession.id } })).toBe(0);
  });
});
