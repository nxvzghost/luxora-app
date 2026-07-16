import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { bootstrapTestApp } from './support/bootstrap-app';
import { loginAs, TENANT_A_ADMIN_EMAIL } from './support/login-helper';
import { uniqueSlot } from './support/unique-slot';

/**
 * [CRÍTICO #8-9] Idempotência de Pagamento — Módulo 09/11.
 * Fonte: docs/09-Testes/01-Testes-Criticos.md, RNF-008.
 */

let app: INestApplication;
let token: string;
let patientId: string;
let therapistId: string;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}
const fixturePrisma = new PrismaClient({
  datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } },
});

async function createBillingWithOneSession(scheduledAt: string, amount: number) {
  const apptRes = await request(app.getHttpServer())
    .post('/api/v1/appointments')
    .set('Authorization', `Bearer ${token}`)
    .send({ patientId, therapistId, scheduledAt, modality: 'presencial' });
  expect(apptRes.status).toBe(201);

  const confirmRes = await request(app.getHttpServer())
    .post(`/api/v1/appointments/${apptRes.body.id}/confirm`)
    .set('Authorization', `Bearer ${token}`);
  expect(confirmRes.status).toBe(201);

  const session = await fixturePrisma.session.findUniqueOrThrow({ where: { appointmentId: apptRes.body.id } });

  const billingRes = await request(app.getHttpServer())
    .post('/api/v1/billings')
    .set('Authorization', `Bearer ${token}`)
    .send({ patientId, amount, dueDate: '2026-12-01', sessionIds: [session.id] });
  expect(billingRes.status).toBe(201);
  return billingRes.body;
}

describe('[CRÍTICO #8] Idempotência de Pagamento (RNF-008)', () => {
  it('duas requisições POST /payments com o mesmo Idempotency-Key produzem exatamente um pagamento', async () => {
    const billing = await createBillingWithOneSession(uniqueSlot(), 300);
    const idempotencyKey = `idem-test-${Date.now()}`;
    const paymentBody = { billingId: billing.id, amount: billing.amount };

    const first = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(paymentBody);
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(paymentBody);
    expect(second.status).toBe(201);

    // Mesmo pagamento retornado nas duas chamadas — nunca um segundo registro.
    expect(second.body.id).toBe(first.body.id);
    const count = await fixturePrisma.payment.count({ where: { idempotencyKey } });
    expect(count).toBe(1);
  });

  it('rejeita POST /payments sem o header Idempotency-Key', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${token}`)
      .send({ billingId: 'qualquer', amount: 100 });
    expect(res.status).toBe(400);
  });
});

describe('[CRÍTICO #9] Reenvio de mensagem pela fila após falha simulada não duplica o envio', () => {
  it('BullMQ nunca aceita dois jobs com o mesmo idempotencyKey como jobId', async () => {
    const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    const queue = new Queue('messages', { connection });
    const idempotencyKey = `resend-test-${Date.now()}`;

    await queue.add(
      'send-message',
      { tenantId: 't', toPhoneNumber: 'x', body: 'primeira tentativa', idempotencyKey },
      { jobId: idempotencyKey },
    );
    // Reenvio simulado (ex: após falha de rede) com o MESMO idempotencyKey —
    // BullMQ silenciosamente ignora, nunca cria um segundo job.
    await queue.add(
      'send-message',
      { tenantId: 't', toPhoneNumber: 'x', body: 'reenvio', idempotencyKey },
      { jobId: idempotencyKey },
    );

    const job = await queue.getJob(idempotencyKey);
    expect(job).not.toBeNull();
    // O job existente NUNCA foi sobrescrito pelo reenvio — mantém o payload
    // original, prova de que o segundo add() foi um no-op real, não um
    // "sucesso" que na verdade substituiu silenciosamente o primeiro.
    expect(job?.data.body).toBe('primeira tentativa');

    await queue.close();
    await connection.quit();
  });
});

beforeAll(async () => {
  await fixturePrisma.$connect();
  app = await bootstrapTestApp();
  token = await loginAs(app, TENANT_A_ADMIN_EMAIL);

  const patientsRes = await request(app.getHttpServer())
    .get('/api/v1/patients')
    .set('Authorization', `Bearer ${token}`);
  patientId = patientsRes.body.data[0].id;

  const therapistsRes = await request(app.getHttpServer())
    .get('/api/v1/therapists')
    .set('Authorization', `Bearer ${token}`);
  therapistId = therapistsRes.body.data[0].id;
});

afterAll(async () => {
  await fixturePrisma.$disconnect();
  await app.close();
});
