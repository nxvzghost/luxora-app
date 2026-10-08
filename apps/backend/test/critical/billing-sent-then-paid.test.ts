import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { uniqueSlot } from './support/unique-slot';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * [CRÍTICO — Tarefa 05 da auditoria] O caminho que a clínica percorre pela
 * tela: gerar a cobrança, ENVIAR ao paciente, registrar o pagamento e, se
 * for o caso, estornar. Os testes existentes registravam o pagamento logo
 * depois de gerar a cobrança, sem enviá-la.
 *
 * Nenhuma mensagem sai da máquina: bootstrapTestApp() não sobe o worker da
 * fila de saída, e o canal gravado aqui usa um token fictício.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let fixture: DedicatedFixture;
let otherClinic: DedicatedFixture;
let token: string;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

const api = () => request(app.getHttpServer());
const auth = () => ({ Authorization: `Bearer ${token}` });

async function createBilling(): Promise<{ billingId: string; sessionId: string }> {
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
  return { billingId: billing.body.id, sessionId: session.id };
}

async function createSentBilling(): Promise<{ billingId: string; sessionId: string }> {
  const created = await createBilling();
  const sent = await api().post(`/api/v1/billings/${created.billingId}/send`).set(auth());
  expect(sent.status).toBe(201);
  expect(sent.body.state).toBe('Enviada');
  return created;
}

async function pay(billingId: string, amount: number) {
  const payment = await api().post('/api/v1/payments').set(auth()).set('Idempotency-Key', `sentpaid-${billingId}`).send({ billingId, amount });
  const stored = await fixturePrisma.payment.findUnique({ where: { billingId } });
  if (stored && !fixture.paymentIds.includes(stored.id)) fixture.paymentIds.push(stored.id);
  return payment;
}

async function listedBilling(billingId: string) {
  const list = await api().get('/api/v1/billings?limit=100').set(auth());
  expect(list.status).toBe(200);
  return (list.body.data as Array<{ id: string; state: string; paymentState: string | null }>).find((billing) => billing.id === billingId);
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  app = await bootstrapTestApp();
  // A clínica do teste nasce SEM canal; a outra, com canal — para provar que o canal de uma não vale para a outra.
  fixture = await createDedicatedFixture(fixturePrisma, 'SENTPAID', { withActiveSubscription: true, withAvailabilityCalendar: true });
  otherClinic = await createDedicatedFixture(fixturePrisma, 'SENTPAID-OUTRA', { withWhatsAppChannel: true });
  token = await createDedicatedUserAndLogin(fixturePrisma, app, fixture, 'SENTPAID');
});

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await cleanupDedicatedFixture(fixturePrisma, otherClinic);
  await fixturePrisma.$disconnect();
  await app.close();
});

describe('[CRÍTICO — Tarefa 05] Enviar cobrança exige WhatsApp conectado', () => {
  let billingId: string;

  it('sem canal conectado, o envio é recusado e a cobrança continua Criada — mesmo com outra clínica conectada', async () => {
    ({ billingId } = await createBilling());

    const sent = await api().post(`/api/v1/billings/${billingId}/send`).set(auth());

    expect(sent.status).toBe(409);
    expect(sent.body.error.code).toBe('WHATSAPP_NOT_CONNECTED');
    expect((await api().get(`/api/v1/billings/${billingId}`).set(auth())).body.state).toBe('Criada');
  });

  it('depois de conectar o canal pela API, a mesma cobrança é enviada', async () => {
    const connect = await api()
      .post('/api/v1/whatsapp/connect')
      .set(auth())
      .send({ phoneNumberId: `sentpaid-${randomUUID()}`, accessToken: 'token-ficticio-de-teste' });
    expect(connect.status).toBe(201);

    const sent = await api().post(`/api/v1/billings/${billingId}/send`).set(auth());

    expect(sent.status).toBe(201);
    expect(sent.body.state).toBe('Enviada');
  });

  it('canal desativado conta como não conectado', async () => {
    await fixturePrisma.whatsAppIntegration.update({ where: { tenantId: fixture.tenantId }, data: { active: false } });
    try {
      const { billingId: another } = await createBilling();
      const sent = await api().post(`/api/v1/billings/${another}/send`).set(auth());
      expect(sent.status).toBe(409);
      expect(sent.body.error.code).toBe('WHATSAPP_NOT_CONNECTED');
    } finally {
      await fixturePrisma.whatsAppIntegration.update({ where: { tenantId: fixture.tenantId }, data: { active: true } });
    }
  });
});

describe('[CRÍTICO — Tarefa 05] Cobrança enviada e depois paga', () => {
  it('registrar o pagamento de uma cobrança já enviada quita a cobrança e a sessão', async () => {
    const { billingId, sessionId } = await createSentBilling();

    const payment = await pay(billingId, 300);

    expect(payment.status).toBe(201);
    expect(payment.body.state).toBe('Confirmado');
    expect((await api().get(`/api/v1/billings/${billingId}`).set(auth())).body.state).toBe('Quitada');
    expect((await fixturePrisma.session.findUniqueOrThrow({ where: { id: sessionId } })).state).toBe('Recebida');
  });
});

describe('[CRÍTICO — Tarefa 05] A lista de cobranças informa o estado do pagamento', () => {
  it('sem pagamento é null; pago é Confirmado; estornado é Estornado, com a cobrança ainda Quitada (ADR-0052)', async () => {
    const { billingId } = await createSentBilling();
    expect(await listedBilling(billingId)).toMatchObject({ state: 'Enviada', paymentState: null });

    const payment = await pay(billingId, 300);
    expect(payment.status).toBe(201);
    expect(await listedBilling(billingId)).toMatchObject({ state: 'Quitada', paymentState: 'Confirmado' });

    const refund = await api().post(`/api/v1/payments/${payment.body.id}/refund`).set(auth());
    expect(refund.status).toBe(201);
    expect(await listedBilling(billingId)).toMatchObject({ state: 'Quitada', paymentState: 'Estornado' });
  });

  it('pagamento de valor diferente aparece como Divergente e a cobrança continua em aberto', async () => {
    const { billingId } = await createSentBilling();

    const payment = await pay(billingId, 250);

    expect(payment.status).toBe(201);
    expect(await listedBilling(billingId)).toMatchObject({ state: 'Enviada', paymentState: 'Divergente' });
  });
});
