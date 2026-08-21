import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaNotificationRepository } from '@infrastructure/database/repositories/prisma-notification.repository';
import { TenantContext } from '@shared/tenant-context';
import { bootstrapTestApp } from './support/bootstrap-app';
import { uniqueSlot } from './support/unique-slot';
import {
  createDedicatedFixture,
  createDedicatedUserAndLogin,
  cleanupDedicatedFixture,
  DedicatedFixture,
} from './support/dedicated-fixture';

/**
 * [CRÍTICO — Epic 12/AD-021] Notification de Pagamento Divergente.
 * Fonte: HANDOFF Epic 12, seções 4/16/21 — teste crítico contra PostgreSQL
 * real, mesmo padrão de payment-idempotency.test.ts (fluxo HTTP real),
 * audit-immutability.test.ts (repository/service instanciados direto) e
 * multi-tenant-isolation.test.ts (prova de RLS via conexão sem app.tenant_id).
 */

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

describe('[CRÍTICO] Notification gerada por PaymentStateChangedEvent (Divergente)', () => {
  let app: INestApplication;
  let fixturePrisma: PrismaClient;
  let fixtureA: DedicatedFixture;
  let fixtureB: DedicatedFixture;

  async function createBillingWithOneSession(fixture: DedicatedFixture, scheduledAt: string, amount: number) {
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

    const billingRes = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ patientId: fixture.patientId, amount, dueDate: '2026-12-01', sessionIds: [session.id] });
    expect(billingRes.status).toBe(201);
    fixture.billingIds.push(billingRes.body.id);
    return billingRes.body;
  }

  async function registerPayment(fixture: DedicatedFixture, billingId: string, amount: number) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${fixture.token}`)
      .set('Idempotency-Key', `notif-crit-${randomUUID()}`)
      .send({ billingId, amount });
    expect(res.status).toBe(201);
    fixture.paymentIds.push(res.body.id);
    return res.body;
  }

  it('pagamento Divergente gera exatamente uma Notification persistida, com os campos corretos', async () => {
    const billing = await createBillingWithOneSession(fixtureA, uniqueSlot(), 400);
    const payment = await registerPayment(fixtureA, billing.id, 350); // diverge de 400

    expect(payment.state).toBe('Divergente');

    const notifications = await fixturePrisma.notification.findMany({ where: { entityId: payment.id } });
    expect(notifications).toHaveLength(1);

    const notification = notifications[0];
    expect(notification.tenantId).toBe(fixtureA.tenantId);
    expect(notification.type).toBe('payment_divergent');
    expect(notification.entityType).toBe('Payment');
    expect(notification.entityId).toBe(payment.id);
    expect(notification.message).toContain(billing.id);
    expect(notification.message).toContain('400.00'); // valor esperado da Billing
    expect(notification.readAt).toBeNull();
  });

  it('pagamento Confirmado NÃO gera Notification', async () => {
    const billing = await createBillingWithOneSession(fixtureA, uniqueSlot(), 400);
    const payment = await registerPayment(fixtureA, billing.id, 400); // confere

    expect(payment.state).toBe('Confirmado');

    const notifications = await fixturePrisma.notification.findMany({ where: { entityId: payment.id } });
    expect(notifications).toHaveLength(0);
  });

  it('Tenant A não consegue ler, via NotificationRepository, uma Notification pertencente ao Tenant B', async () => {
    const billingB = await createBillingWithOneSession(fixtureB, uniqueSlot(), 500);
    const paymentB = await registerPayment(fixtureB, billingB.id, 350); // diverge de 500
    const notificationB = await fixturePrisma.notification.findFirstOrThrow({ where: { entityId: paymentB.id } });

    const client = new PrismaClientProvider();
    await client.$connect();
    try {
      const tenantContextA = new TenantContext();
      tenantContextA.set(fixtureA.tenantId, fixtureA.userId ?? 'user-a');
      const repoAsA = new PrismaNotificationRepository(new PrismaService(client, tenantContextA));

      const found = await repoAsA.findById(notificationB.id);
      expect(found).toBeNull();
    } finally {
      await client.$disconnect();
    }
  });

  it('conexão sem app.tenant_id não enxerga a Notification mesmo pedindo o id diretamente (RLS real)', async () => {
    const billing = await createBillingWithOneSession(fixtureA, uniqueSlot(), 420);
    const payment = await registerPayment(fixtureA, billing.id, 300); // diverge de 420
    const notification = await fixturePrisma.notification.findFirstOrThrow({ where: { entityId: payment.id } });

    // Conexão nova, com o mesmo role de produção (luxora_app, sem BYPASSRLS),
    // SEM SET app.tenant_id — simula bug de programação; RLS deve barrar mesmo assim.
    const plainPrisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL ?? '' } } });
    try {
      await plainPrisma.$connect();
      const rows: unknown[] = await plainPrisma.$queryRawUnsafe(
        `SELECT * FROM notification WHERE id = '${notification.id}'`,
      );
      expect(rows).toHaveLength(0);
    } finally {
      await plainPrisma.$disconnect();
    }
  });

  it('PrismaNotificationRepository (findByTenant/findById/countUnreadByTenant/markAsRead) contra PostgreSQL real', async () => {
    const billing = await createBillingWithOneSession(fixtureA, uniqueSlot(), 600);
    const payment = await registerPayment(fixtureA, billing.id, 480); // diverge de 600

    const client = new PrismaClientProvider();
    await client.$connect();
    try {
      const tenantContextA = new TenantContext();
      tenantContextA.set(fixtureA.tenantId, fixtureA.userId ?? 'user-a');
      const repoAsA = new PrismaNotificationRepository(new PrismaService(client, tenantContextA));

      const listed = await repoAsA.findByTenant({ limit: 50 });
      const target = listed.find((n) => n.entityId === payment.id);
      expect(target).toBeDefined();
      expect(target!.isRead).toBe(false);

      const found = await repoAsA.findById(target!.id);
      expect(found).not.toBeNull();
      expect(found!.entityId).toBe(payment.id);
      expect(found!.readAt).toBeNull();

      const unreadBefore = await repoAsA.countUnreadByTenant();
      expect(unreadBefore).toBeGreaterThanOrEqual(1);

      const marked = await repoAsA.markAsRead(target!.id);
      expect(marked.readAt).toBeInstanceOf(Date);
      expect(marked.isRead).toBe(true);

      const afterRead = await repoAsA.findById(target!.id);
      expect(afterRead!.readAt).toBeInstanceOf(Date);
      expect(afterRead!.isRead).toBe(true);

      const unreadAfter = await repoAsA.countUnreadByTenant();
      expect(unreadAfter).toBe(unreadBefore - 1);

      // markAsRead é idempotente — segunda chamada não lança e não altera o readAt.
      const markedAgain = await repoAsA.markAsRead(target!.id);
      expect(markedAgain.readAt).toEqual(afterRead!.readAt);
    } finally {
      await client.$disconnect();
    }
  });

  describe('API HTTP de notificações (GET/POST)', () => {
    it('GET /notifications lista as notificações do tenant autenticado, mais recente primeiro', async () => {
      const billing = await createBillingWithOneSession(fixtureA, uniqueSlot(), 700);
      const payment = await registerPayment(fixtureA, billing.id, 550); // diverge de 700

      const res = await request(app.getHttpServer())
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${fixtureA.token}`);

      expect(res.status).toBe(200);
      const found = res.body.data.find((n: { entityId: string }) => n.entityId === payment.id);
      expect(found).toBeDefined();
      expect(found.type).toBe('payment_divergent');
      expect(found.readAt).toBeNull();
    });

    it('GET /notifications/unread-count reflete o total de não lidas do tenant', async () => {
      const billing = await createBillingWithOneSession(fixtureA, uniqueSlot(), 800);
      await registerPayment(fixtureA, billing.id, 650); // diverge de 800, gera 1 notificação

      const res = await request(app.getHttpServer())
        .get('/api/v1/notifications/unread-count')
        .set('Authorization', `Bearer ${fixtureA.token}`);

      expect(res.status).toBe(200);
      expect(res.body.count).toBeGreaterThanOrEqual(1);
    });

    it('POST /notifications/:id/read marca como lida e devolve a Notification atualizada', async () => {
      const billing = await createBillingWithOneSession(fixtureA, uniqueSlot(), 900);
      const payment = await registerPayment(fixtureA, billing.id, 720); // diverge de 900
      const notification = await fixturePrisma.notification.findFirstOrThrow({ where: { entityId: payment.id } });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/notifications/${notification.id}/read`)
        .set('Authorization', `Bearer ${fixtureA.token}`);

      expect(res.status).toBe(201);
      expect(res.body.id).toBe(notification.id);
      expect(res.body.readAt).not.toBeNull();
    });

    it('POST /notifications/:id/read para uma Notification de outro tenant devolve 404 (RLS via HTTP)', async () => {
      const billing = await createBillingWithOneSession(fixtureA, uniqueSlot(), 1000);
      const payment = await registerPayment(fixtureA, billing.id, 810); // diverge de 1000
      const notification = await fixturePrisma.notification.findFirstOrThrow({ where: { entityId: payment.id } });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/notifications/${notification.id}/read`)
        .set('Authorization', `Bearer ${fixtureB.token}`);

      expect(res.status).toBe(404);
    });
  });

  beforeAll(async () => {
    fixturePrisma = new PrismaClient({
      datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } },
    });
    await fixturePrisma.$connect();

    app = await bootstrapTestApp();

    fixtureA = await createDedicatedFixture(fixturePrisma, 'NOTIFDIV-A', {
      withActiveSubscription: true,
      withAvailabilityCalendar: true,
    });
    await createDedicatedUserAndLogin(fixturePrisma, app, fixtureA, 'NOTIFDIV-A');

    fixtureB = await createDedicatedFixture(fixturePrisma, 'NOTIFDIV-B', {
      withActiveSubscription: true,
      withAvailabilityCalendar: true,
    });
    await createDedicatedUserAndLogin(fixturePrisma, app, fixtureB, 'NOTIFDIV-B');
  });

  afterAll(async () => {
    await cleanupDedicatedFixture(fixturePrisma, fixtureA);
    await cleanupDedicatedFixture(fixturePrisma, fixtureB);
    await fixturePrisma.$disconnect();
    await app.close();
  });
});
