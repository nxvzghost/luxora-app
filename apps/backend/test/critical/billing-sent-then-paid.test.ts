import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { uniqueSlot } from './support/unique-slot';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * [CRÍTICO — Tarefa 05 da auditoria] O caminho que a clínica percorre pela
 * tela: gerar a cobrança, ENVIAR ao paciente e só depois registrar o
 * pagamento. Os testes existentes registravam o pagamento logo depois de
 * gerar a cobrança, sem enviá-la.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let fixture: DedicatedFixture;
let token: string;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

const api = () => request(app.getHttpServer());
const auth = () => ({ Authorization: `Bearer ${token}` });

async function createSentBilling(): Promise<{ billingId: string; sessionId: string }> {
  const appointment = await api()
    .post('/api/v1/appointments')
    .set(auth())
    .send({ patientId: fixture.patientId, therapistId: fixture.therapistId, scheduledAt: uniqueSlot(), modality: 'presencial' });
  expect(appointment.status).toBe(201);
  fixture.appointmentIds.push(appointment.body.id);
  expect((await api().post(`/api/v1/appointments/${appointment.body.id}/confirm`).set(auth())).status).toBe(201);
  const session = await fixturePrisma.session.findUniqueOrThrow({ where: { appointmentId: appointment.body.id } });
  fixture.sessionIds.push(session.id);

  const billing = await api()
    .post('/api/v1/billings')
    .set(auth())
    .send({ patientId: fixture.patientId, amount: 300, dueDate: '2027-02-10', sessionIds: [session.id] });
  expect(billing.status).toBe(201);
  fixture.billingIds.push(billing.body.id);

  const sent = await api().post(`/api/v1/billings/${billing.body.id}/send`).set(auth());
  expect(sent.status).toBe(201);
  expect(sent.body.state).toBe('Enviada');
  return { billingId: billing.body.id, sessionId: session.id };
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  app = await bootstrapTestApp();
  fixture = await createDedicatedFixture(fixturePrisma, 'SENTPAID', { withActiveSubscription: true, withAvailabilityCalendar: true });
  token = await createDedicatedUserAndLogin(fixturePrisma, app, fixture, 'SENTPAID');
});

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await fixturePrisma.$disconnect();
  await app.close();
});

describe('[CRÍTICO — Tarefa 05] Cobrança enviada e depois paga', () => {
  it('registrar o pagamento de uma cobrança já enviada quita a cobrança e a sessão', async () => {
    const { billingId, sessionId } = await createSentBilling();

    const payment = await api()
      .post('/api/v1/payments')
      .set(auth())
      .set('Idempotency-Key', `sentpaid-${billingId}`)
      .send({ billingId, amount: 300 });
    if (payment.body.id) fixture.paymentIds.push(payment.body.id);
    const stored = await fixturePrisma.payment.findUnique({ where: { billingId } });
    if (stored && !fixture.paymentIds.includes(stored.id)) fixture.paymentIds.push(stored.id);

    expect(payment.status).toBe(201);
    expect(payment.body.state).toBe('Confirmado');
    expect((await api().get(`/api/v1/billings/${billingId}`).set(auth())).body.state).toBe('Quitada');
    expect((await fixturePrisma.session.findUniqueOrThrow({ where: { id: sessionId } })).state).toBe('Recebida');
  });
});
