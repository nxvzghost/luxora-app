import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * Fase 3 da auditoria — webhook da Asaas, ponta a ponta contra Postgres
 * real: POST /webhooks/asaas → AsaasWebhookGuard → localização da
 * assinatura pelo id da Asaas → mudança de estado → auditoria → registro
 * do evento. Nenhuma chamada à Asaas acontece aqui (o webhook só recebe).
 *
 * Até esta fase o fluxo só tinha teste unitário do Use Case, com
 * repositórios simulados — autenticação, idempotência no banco e
 * isolamento entre clínicas nunca tinham sido exercitados de verdade.
 *
 * `clinic_subscription` não tem RLS por desenho (o webhook precisa achar a
 * assinatura antes de conhecer a clínica), então o isolamento aqui depende
 * só do id da assinatura na Asaas — é exatamente isso que os testes
 * negativos abaixo cobram.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let tenantA: DedicatedFixture;
let tenantB: DedicatedFixture;
let webhookToken: string;

const asaasSubscriptionA = `sub_teste_a_${randomUUID()}`;
const asaasSubscriptionB = `sub_teste_b_${randomUUID()}`;
const eventIds: string[] = [];

function newEventId(): string {
  const id = `evt_teste_${randomUUID()}`;
  eventIds.push(id);
  return id;
}

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

function post(payload: unknown, token: string | null = webhookToken) {
  let req = request(app.getHttpServer()).post('/api/v1/webhooks/asaas').set('Content-Type', 'application/json');
  if (token !== null) {
    req = req.set('asaas-access-token', token);
  }
  return req.send(payload as object);
}

async function subscriptionOf(fixture: DedicatedFixture) {
  return fixturePrisma.clinicSubscription.findUniqueOrThrow({ where: { tenantId: fixture.tenantId } });
}

async function auditCount(fixture: DedicatedFixture) {
  return fixturePrisma.auditLog.count({ where: { tenantId: fixture.tenantId } });
}

beforeAll(async () => {
  process.env.ASAAS_WEBHOOK_TOKEN ||= 'token-de-webhook-so-da-suite-critica';
  webhookToken = process.env.ASAAS_WEBHOOK_TOKEN;

  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();

  app = await bootstrapTestApp();

  tenantA = await createDedicatedFixture(fixturePrisma, 'ASAASWHA', { withActiveSubscription: true });
  tenantB = await createDedicatedFixture(fixturePrisma, 'ASAASWHB', { withActiveSubscription: true });

  await fixturePrisma.clinicSubscription.update({
    where: { tenantId: tenantA.tenantId },
    data: { status: 'trialing', asaasSubscriptionId: asaasSubscriptionA },
  });
  await fixturePrisma.clinicSubscription.update({
    where: { tenantId: tenantB.tenantId },
    data: { asaasSubscriptionId: asaasSubscriptionB },
  });
});

afterAll(async () => {
  await fixturePrisma.asaasWebhookEvent.deleteMany({ where: { asaasEventId: { in: eventIds } } });
  await cleanupDedicatedFixture(fixturePrisma, tenantA);
  await cleanupDedicatedFixture(fixturePrisma, tenantB);
  await fixturePrisma.$disconnect();
  await app?.close();
});

describe('[Fase 3] POST /webhooks/asaas — autenticação', () => {
  it('sem o header do token: 401, nada alterado', async () => {
    const eventId = newEventId();
    const res = await post({ id: eventId, event: 'PAYMENT_CONFIRMED', subscription: { id: asaasSubscriptionA } }, null);

    expect(res.status).toBe(401);
    expect((await subscriptionOf(tenantA)).status).toBe('trialing');
    expect(await fixturePrisma.asaasWebhookEvent.count({ where: { asaasEventId: eventId } })).toBe(0);
  });

  it('token errado: 401, nada alterado', async () => {
    const eventId = newEventId();
    const res = await post({ id: eventId, event: 'PAYMENT_CONFIRMED', subscription: { id: asaasSubscriptionA } }, 'token-errado');

    expect(res.status).toBe(401);
    expect((await subscriptionOf(tenantA)).status).toBe('trialing');
    expect(await fixturePrisma.asaasWebhookEvent.count({ where: { asaasEventId: eventId } })).toBe(0);
  });
});

describe('[Fase 3] POST /webhooks/asaas — estado, idempotência e isolamento', () => {
  it('PAYMENT_CONFIRMED ativa só a assinatura da clínica A, com auditoria só na clínica A', async () => {
    const beforeB = await subscriptionOf(tenantB);
    const auditBeforeA = await auditCount(tenantA);
    const auditBeforeB = await auditCount(tenantB);
    const eventId = newEventId();

    const res = await post({ id: eventId, event: 'PAYMENT_CONFIRMED', subscription: { id: asaasSubscriptionA } });
    expect(res.status).toBe(200);

    const afterA = await subscriptionOf(tenantA);
    expect(afterA.status).toBe('active');
    expect(afterA.currentPeriodEnd).not.toBeNull();
    expect(await auditCount(tenantA)).toBeGreaterThan(auditBeforeA);

    const afterB = await subscriptionOf(tenantB);
    expect(afterB.status).toBe(beforeB.status);
    expect(afterB.updatedAt.getTime()).toBe(beforeB.updatedAt.getTime());
    expect(await auditCount(tenantB)).toBe(auditBeforeB);

    expect(await fixturePrisma.asaasWebhookEvent.count({ where: { asaasEventId: eventId } })).toBe(1);
  });

  it('reentrega do mesmo evento: 200, nenhum efeito novo (ciclo não avança de novo, sem segunda auditoria)', async () => {
    const eventId = newEventId();
    const payload = { id: eventId, event: 'PAYMENT_RECEIVED', payment: { subscription: asaasSubscriptionA } };

    expect((await post(payload)).status).toBe(200);
    const afterFirst = await subscriptionOf(tenantA);
    const auditAfterFirst = await auditCount(tenantA);

    expect((await post(payload)).status).toBe(200);
    expect((await post(payload)).status).toBe(200);

    const afterReplays = await subscriptionOf(tenantA);
    expect(afterReplays.currentPeriodEnd?.getTime()).toBe(afterFirst.currentPeriodEnd?.getTime());
    expect(afterReplays.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());
    expect(await auditCount(tenantA)).toBe(auditAfterFirst);
    expect(await fixturePrisma.asaasWebhookEvent.count({ where: { asaasEventId: eventId } })).toBe(1);
  });

  it('PAYMENT_OVERDUE da clínica B (id vindo em payment.subscription) muda só a clínica B', async () => {
    const beforeA = await subscriptionOf(tenantA);
    const auditBeforeA = await auditCount(tenantA);

    const res = await post({ id: newEventId(), event: 'PAYMENT_OVERDUE', payment: { subscription: asaasSubscriptionB } });
    expect(res.status).toBe(200);

    const afterB = await subscriptionOf(tenantB);
    expect(afterB.status).toBe('past_due');
    expect(afterB.pastDueSince).not.toBeNull();

    const afterA = await subscriptionOf(tenantA);
    expect(afterA.status).toBe(beforeA.status);
    expect(afterA.updatedAt.getTime()).toBe(beforeA.updatedAt.getTime());
    expect(await auditCount(tenantA)).toBe(auditBeforeA);
  });

  it('evento de tipo desconhecido: 200, registrado como recebido, nenhuma assinatura alterada', async () => {
    const beforeA = await subscriptionOf(tenantA);
    const eventId = newEventId();

    const res = await post({ id: eventId, event: 'PAYMENT_ALGO_QUE_NAO_EXISTE', subscription: { id: asaasSubscriptionA } });
    expect(res.status).toBe(200);

    expect((await subscriptionOf(tenantA)).updatedAt.getTime()).toBe(beforeA.updatedAt.getTime());
    expect(await fixturePrisma.asaasWebhookEvent.count({ where: { asaasEventId: eventId } })).toBe(1);
  });

  it('assinatura que não existe na Luxora: 200, nenhuma clínica alterada', async () => {
    const beforeA = await subscriptionOf(tenantA);
    const beforeB = await subscriptionOf(tenantB);

    const res = await post({ id: newEventId(), event: 'SUBSCRIPTION_DELETED', subscription: { id: `sub_inexistente_${randomUUID()}` } });
    expect(res.status).toBe(200);

    expect((await subscriptionOf(tenantA)).updatedAt.getTime()).toBe(beforeA.updatedAt.getTime());
    expect((await subscriptionOf(tenantB)).updatedAt.getTime()).toBe(beforeB.updatedAt.getTime());
  });

  it.each([
    ['sem id', { event: 'PAYMENT_CONFIRMED', subscription: { id: asaasSubscriptionA } }],
    ['sem tipo de evento', { id: `evt_teste_sem_tipo_${randomUUID()}`, subscription: { id: asaasSubscriptionA } }],
    ['corpo vazio', {}],
  ])('payload inválido (%s): 200, nada alterado, nada registrado', async (_label, payload) => {
    const beforeA = await subscriptionOf(tenantA);

    const res = await post(payload);
    expect(res.status).toBe(200);

    expect((await subscriptionOf(tenantA)).updatedAt.getTime()).toBe(beforeA.updatedAt.getTime());
    if ('id' in payload) {
      expect(await fixturePrisma.asaasWebhookEvent.count({ where: { asaasEventId: payload.id as string } })).toBe(0);
    }
  });
});
