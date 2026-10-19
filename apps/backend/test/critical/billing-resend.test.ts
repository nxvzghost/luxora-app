import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, UserRole } from '@prisma/client';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { bootstrapTestApp } from './support/bootstrap-app';
import { uniqueSlot } from './support/unique-slot';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * [CRÍTICO] Reenvio de cobrança depois de um aviso de falha (ADR-0066), de
 * ponta a ponta: rota, RBAC, RLS, fila real e auditoria. O worker da fila de
 * saída está desligado nesta suíte: os jobs são conferidos e retirados aqui.
 */

let app: INestApplication;
let db: PrismaClient;
let fixture: DedicatedFixture;
let otherClinic: DedicatedFixture;
let admin: { token: string; userId: string };
let therapist: string;
let otherAdmin: string;
let connection: IORedis;
let queue: Queue;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

const api = () => request(app.getHttpServer());
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

async function sentBilling(): Promise<string> {
  const appointment = await api()
    .post('/api/v1/appointments')
    .set(as(admin.token))
    .send({ patientId: fixture.patientId, therapistId: fixture.therapistId, scheduledAt: uniqueSlot(), modality: 'presencial' });
  expect(appointment.status).toBe(201);
  fixture.appointmentIds.push(appointment.body.id);
  expect((await api().post(`/api/v1/appointments/${appointment.body.id}/confirm`).set(as(admin.token))).status).toBe(201);
  const session = await db.session.findUniqueOrThrow({ where: { appointmentId: appointment.body.id } });
  fixture.sessionIds.push(session.id);

  const billing = await api()
    .post('/api/v1/billings')
    .set(as(admin.token))
    .send({ patientId: fixture.patientId, amount: 300, dueDate: '2027-02-10', sessionIds: [session.id] });
  expect(billing.status).toBe(201);
  fixture.billingIds.push(billing.body.id);
  expect((await api().post(`/api/v1/billings/${billing.body.id}/send`).set(as(admin.token))).status).toBe(201);
  await queue.remove(`billing-${billing.body.id}`).catch(() => undefined);
  return billing.body.id;
}

/** O aviso que a A-08 cria quando a mensagem da cobrança não sai. */
async function failureNotice(billingId: string, type = 'whatsapp_send_failed'): Promise<string> {
  const row = await db.notification.create({
    data: {
      tenantId: fixture.tenantId,
      type,
      title: 'WhatsApp: mensagem não enviada',
      message: 'A cobrança para o número com final 0000 não foi enviada.',
      entityType: 'Billing',
      entityId: billingId,
    },
  });
  return row.id;
}

const resend = (token: string, billingId: string) => api().post(`/api/v1/billings/${billingId}/resend`).set(as(token));

beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await db.$connect();
  app = await bootstrapTestApp();
  fixture = await createDedicatedFixture(db, 'RESEND', { withActiveSubscription: true, withAvailabilityCalendar: true, withWhatsAppChannel: true });
  otherClinic = await createDedicatedFixture(db, 'RESEND-OUTRA', { withActiveSubscription: true, withWhatsAppChannel: true });
  const token = await createDedicatedUserAndLogin(db, app, fixture, 'RESEND', UserRole.admin);
  admin = { token, userId: fixture.userId as string };
  therapist = await createDedicatedUserAndLogin(db, app, fixture, 'RESEND', UserRole.therapist);
  otherAdmin = await createDedicatedUserAndLogin(db, app, otherClinic, 'RESEND-OUTRA', UserRole.admin);
  connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
  queue = new Queue('messages', { connection });
}, 90_000);

afterAll(async () => {
  await queue?.close();
  await connection?.quit();
  await cleanupDedicatedFixture(db, fixture);
  await cleanupDedicatedFixture(db, otherClinic);
  await db.$disconnect();
  await app?.close();
}, 90_000);

describe('[CRÍTICO] reenvio de cobrança depois de um aviso de falha', () => {
  it('reenvia: a mesma mensagem vai de novo para a fila, o aviso é dado por tratado, a cobrança continua Enviada e fica o registro', async () => {
    const billingId = await sentBilling();
    const noticeId = await failureNotice(billingId);

    const res = await resend(admin.token, billingId);
    expect(res.status).toBe(201);
    expect(res.body.state).toBe('Enviada');

    const job = await queue.getJob(`billing-${billingId}-resend-${noticeId}`);
    expect(job?.data).toMatchObject({ tenantId: fixture.tenantId, body: expect.stringContaining('300') });
    await job?.remove().catch(() => undefined);

    expect((await db.notification.findUniqueOrThrow({ where: { id: noticeId } })).readAt).not.toBeNull();
    expect((await db.billing.findUniqueOrThrow({ where: { id: billingId } })).status).toBe('enviada'); // no banco o estado é gravado em minúsculas
    const audits = await db.auditLog.findMany({ where: { entityId: billingId, action: 'CobrancaReenviada' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: fixture.tenantId, userId: admin.userId });
    expect(audits[0].payload).toMatchObject({ failureNoticeId: noticeId });
  });

  it('reenviar de novo sem aviso novo: 409 — o botão não serve para mandar a cobrança várias vezes', async () => {
    const billingId = await sentBilling();
    await failureNotice(billingId);
    expect((await resend(admin.token, billingId)).status).toBe(201);

    expect((await resend(admin.token, billingId)).status).toBe(409);
    expect(await db.auditLog.count({ where: { entityId: billingId, action: 'CobrancaReenviada' } })).toBe(1);
  });

  it('sem aviso de falha: 409 e nada vai para a fila', async () => {
    const billingId = await sentBilling();
    const before = (await queue.getJobs(['waiting', 'delayed', 'active'])).filter((job) => job.id?.startsWith(`billing-${billingId}-resend`));
    expect((await resend(admin.token, billingId)).status).toBe(409);
    const after = (await queue.getJobs(['waiting', 'delayed', 'active'])).filter((job) => job.id?.startsWith(`billing-${billingId}-resend`));
    expect(after).toHaveLength(before.length);
  });

  it('aviso de falha de entrega também vale', async () => {
    const billingId = await sentBilling();
    const noticeId = await failureNotice(billingId, 'whatsapp_delivery_failed');
    expect((await resend(admin.token, billingId)).status).toBe(201);
    await queue.remove(`billing-${billingId}-resend-${noticeId}`).catch(() => undefined);
  });

  it('terapeuta: 403, e o aviso continua em aberto', async () => {
    const billingId = await sentBilling();
    const noticeId = await failureNotice(billingId);
    expect((await resend(therapist, billingId)).status).toBe(403);
    expect((await db.notification.findUniqueOrThrow({ where: { id: noticeId } })).readAt).toBeNull();
  });

  it('administrador de outra clínica: 404, e nada muda', async () => {
    const billingId = await sentBilling();
    const noticeId = await failureNotice(billingId);
    expect((await resend(otherAdmin, billingId)).status).toBe(404);
    expect((await db.notification.findUniqueOrThrow({ where: { id: noticeId } })).readAt).toBeNull();
    expect(await db.auditLog.count({ where: { entityId: billingId, action: 'CobrancaReenviada' } })).toBe(0);
  });

  it('cobrança que não existe: 404', async () => {
    expect((await resend(admin.token, randomUUID())).status).toBe(404);
  });
});
