import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { uniqueSlot } from './support/unique-slot';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * AD-009 (ADR-0052) — Session.state acompanha o ciclo financeiro real:
 * Realizada → Faturada (ao gerar a cobrança) → Recebida (ao confirmar o
 * pagamento que quita a cobrança). Antes desta AD, Faturada/Recebida eram
 * código morto — nenhum caminho de aplicação os alcançava (ver
 * AUDITORIA_TECNICA_DEFINITIVA.md, seção 3.4).
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let fixture: DedicatedFixture;

async function createConfirmedSession(scheduledAt: string = uniqueSlot()): Promise<string> {
  const apptRes = await request(app.getHttpServer())
    .post('/api/v1/appointments')
    .set('Authorization', `Bearer ${fixture.token}`)
    .send({ patientId: fixture.patientId, therapistId: fixture.therapistId, scheduledAt, modality: 'presencial' });
  expect(apptRes.status).toBe(201);
  fixture.appointmentIds.push(apptRes.body.id);

  const confirmRes = await request(app.getHttpServer())
    .post(`/api/v1/appointments/${apptRes.body.id}/confirm`)
    .set('Authorization', `Bearer ${fixture.token}`);
  expect(confirmRes.status).toBe(201);

  const session = await fixturePrisma.session.findUniqueOrThrow({ where: { appointmentId: apptRes.body.id } });
  fixture.sessionIds.push(session.id);
  return session.id;
}

async function sessionState(sessionId: string): Promise<string> {
  const session = await fixturePrisma.session.findUniqueOrThrow({ where: { id: sessionId } });
  return session.state;
}

describe('[AD-009] Session acompanha o ciclo financeiro: Realizada → Faturada → Recebida', () => {
  it('confirmar a consulta cria a Session em Realizada', async () => {
    const sessionId = await createConfirmedSession();
    expect(await sessionState(sessionId)).toBe('Realizada');
  });

  it('gerar a cobrança transiciona a Session vinculada para Faturada, imediatamente — não precisa enviar', async () => {
    const sessionId = await createConfirmedSession();

    const billingRes = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ patientId: fixture.patientId, amount: 400, dueDate: '2026-09-08', sessionIds: [sessionId] });
    expect(billingRes.status).toBe(201);
    fixture.billingIds.push(billingRes.body.id);

    expect(await sessionState(sessionId)).toBe('Faturada');
  });

  it('confirmar o pagamento (valor correto) transiciona a Session para Recebida, junto com a Billing indo para Quitada', async () => {
    const sessionId = await createConfirmedSession();

    const billingRes = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ patientId: fixture.patientId, amount: 400, dueDate: '2026-09-08', sessionIds: [sessionId] });
    expect(billingRes.status).toBe(201);
    fixture.billingIds.push(billingRes.body.id);
    expect(await sessionState(sessionId)).toBe('Faturada');

    const paymentRes = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${fixture.token}`)
      .set('Idempotency-Key', `idem-recebida-${Date.now()}`)
      .send({ billingId: billingRes.body.id, amount: 400 });
    expect(paymentRes.status).toBe(201);
    fixture.paymentIds.push(paymentRes.body.id);

    expect(await sessionState(sessionId)).toBe('Recebida');
    const billing = await fixturePrisma.billing.findUniqueOrThrow({ where: { id: billingRes.body.id } });
    expect(billing.status).toBe('quitada');
  });

  it('pagamento com valor divergente NÃO transiciona a Session — permanece Faturada, nunca pula para Recebida', async () => {
    const sessionId = await createConfirmedSession();

    const billingRes = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ patientId: fixture.patientId, amount: 400, dueDate: '2026-09-08', sessionIds: [sessionId] });
    expect(billingRes.status).toBe(201);
    fixture.billingIds.push(billingRes.body.id);

    const paymentRes = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${fixture.token}`)
      .set('Idempotency-Key', `idem-divergente-${Date.now()}`)
      .send({ billingId: billingRes.body.id, amount: 350 });
    expect(paymentRes.status).toBe(201);
    fixture.paymentIds.push(paymentRes.body.id);
    expect(paymentRes.body.state).toBe('Divergente');

    expect(await sessionState(sessionId)).toBe('Faturada');
    const billing = await fixturePrisma.billing.findUniqueOrThrow({ where: { id: billingRes.body.id } });
    expect(billing.status).not.toBe('quitada');
  });

  it('cobrança agregada de N sessões: todas transicionam para Faturada juntas, e para Recebida juntas ao quitar', async () => {
    const sessionIds = [await createConfirmedSession(), await createConfirmedSession(), await createConfirmedSession()];

    const billingRes = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ patientId: fixture.patientId, amount: 1200, dueDate: '2026-09-15', sessionIds });
    expect(billingRes.status).toBe(201);
    fixture.billingIds.push(billingRes.body.id);

    for (const id of sessionIds) {
      expect(await sessionState(id)).toBe('Faturada');
    }

    const paymentRes = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${fixture.token}`)
      .set('Idempotency-Key', `idem-agregada-${Date.now()}`)
      .send({ billingId: billingRes.body.id, amount: 1200 });
    expect(paymentRes.status).toBe(201);
    fixture.paymentIds.push(paymentRes.body.id);

    for (const id of sessionIds) {
      expect(await sessionState(id)).toBe('Recebida');
    }
  });
});

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({
    datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } },
  });
  await fixturePrisma.$connect();

  app = await bootstrapTestApp();
  fixture = await createDedicatedFixture(fixturePrisma, 'SESSBILL', {
    withActiveSubscription: true,
    withAvailabilityCalendar: true,
  });
  await createDedicatedUserAndLogin(fixturePrisma, app, fixture, 'SESSBILL');
});

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await fixturePrisma.$disconnect();
  await app.close();
});
