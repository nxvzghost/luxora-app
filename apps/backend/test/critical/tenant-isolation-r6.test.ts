import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaMessageLogRepository } from '@infrastructure/database/repositories/prisma-message-log.repository';
import { TenantContext } from '@shared/tenant-context';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * [CRÍTICO — Fase 2 da auditoria, R6] Isolamento entre Tenants nas duas
 * tabelas com tenant_id que estavam sem Row-Level Security.
 *
 *   - message_log: passou a ter RLS (migration
 *     20261005040856_enable_rls_message_log). Provado aqui com a role real
 *     da aplicação (luxora_app), que é quem está sujeita à policy.
 *   - clinic_subscription: continua sem RLS, por desenho — o webhook da
 *     Asaas precisa achar a assinatura antes de conhecer o Tenant. O
 *     isolamento é da aplicação (tenantId sempre do contexto autenticado),
 *     e é isso que os testes da segunda parte provam, por HTTP real.
 *
 * O superusuário (fixturePrisma) só monta e confere o cenário; ele ignora
 * RLS e nunca é usado para afirmar isolamento.
 */

const client = new PrismaClientProvider();
let fixturePrisma: PrismaClient;
let app: INestApplication;
let tenantA: DedicatedFixture;
let tenantB: DedicatedFixture;
let tokenA: string;
let tokenB: string;

const keyOfB = `r6-b-${randomUUID()}`;
const keyOfA = `r6-a-${randomUUID()}`;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

function prismaAs(tenantId: string): PrismaService {
  const context = new TenantContext();
  context.set(tenantId, null);
  return new PrismaService(client, context);
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  await client.$connect();
  app = await bootstrapTestApp();

  tenantA = await createDedicatedFixture(fixturePrisma, 'R6A', { withActiveSubscription: true });
  tenantB = await createDedicatedFixture(fixturePrisma, 'R6B', { withActiveSubscription: true });
  await fixturePrisma.clinicSubscription.update({ where: { id: tenantB.subscriptionId }, data: { plan: 'enterprise' } });
  tokenA = await createDedicatedUserAndLogin(fixturePrisma, app, tenantA, 'R6A');
  tokenB = await createDedicatedUserAndLogin(fixturePrisma, app, tenantB, 'R6B');

  await fixturePrisma.messageLog.create({
    data: {
      tenantId: tenantB.tenantId,
      toPhoneNumber: '5511988887777',
      body: 'Mensagem confidencial do Tenant B',
      idempotencyKey: keyOfB,
      providerMessageId: 'wamid.r6-b',
    },
  });
});

afterAll(async () => {
  if (tenantA && tenantB) {
    // message_log tem FK para tenant e não é coberta por cleanupDedicatedFixture().
    await fixturePrisma.messageLog.deleteMany({ where: { tenantId: { in: [tenantA.tenantId, tenantB.tenantId] } } });
  }
  await cleanupDedicatedFixture(fixturePrisma, tenantA);
  await cleanupDedicatedFixture(fixturePrisma, tenantB);
  await client.$disconnect();
  await fixturePrisma.$disconnect();
  await app?.close();
});

describe('[CRÍTICO — R6] message_log sob Row-Level Security', () => {
  it('a tabela tem RLS habilitada e forçada, com a policy tenant_isolation', async () => {
    const flags = await fixturePrisma.$queryRaw<Array<{ rls: boolean; forced: boolean }>>`
      SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE relname = 'message_log'
    `;
    expect(flags).toEqual([{ rls: true, forced: true }]);

    const policies = await fixturePrisma.$queryRaw<Array<{ policyname: string }>>`
      SELECT policyname FROM pg_policies WHERE tablename = 'message_log'
    `;
    expect(policies.map((p) => p.policyname)).toEqual(['tenant_isolation']);
  });

  it('o Tenant A não lê a linha do Tenant B pela chave de idempotência — nem direto, nem pelo repositório', async () => {
    const direct = await prismaAs(tenantA.tenantId).forTenant((tx) =>
      tx.messageLog.findUnique({ where: { idempotencyKey: keyOfB } }),
    );
    expect(direct).toBeNull();

    // O repositório de produção não filtra por tenant na consulta: é a RLS que isola.
    const viaRepository = await new PrismaMessageLogRepository(prismaAs(tenantA.tenantId)).findByIdempotencyKey(keyOfB);
    expect(viaRepository).toBeNull();
  });

  it('o próprio Tenant B continua lendo a sua linha (controle)', async () => {
    const own = await new PrismaMessageLogRepository(prismaAs(tenantB.tenantId)).findByIdempotencyKey(keyOfB);
    expect(own?.body).toBe('Mensagem confidencial do Tenant B');
  });

  it('o Tenant A grava e lê as próprias linhas, e uma listagem nunca traz linha de outro Tenant', async () => {
    await new PrismaMessageLogRepository(prismaAs(tenantA.tenantId)).record({
      tenantId: tenantA.tenantId,
      toPhoneNumber: '5511977776666',
      body: 'Mensagem do Tenant A',
      idempotencyKey: keyOfA,
      providerMessageId: 'wamid.r6-a',
    });

    const seenByA = await prismaAs(tenantA.tenantId).forTenant((tx) => tx.messageLog.findMany());
    expect(seenByA.map((row) => row.idempotencyKey)).toEqual([keyOfA]);

    const seenByB = await prismaAs(tenantB.tenantId).forTenant((tx) => tx.messageLog.findMany());
    expect(seenByB.map((row) => row.idempotencyKey)).toEqual([keyOfB]);
  });

  it('o Tenant A não consegue gravar uma linha em nome do Tenant B', async () => {
    const attempt = prismaAs(tenantA.tenantId).forTenant((tx) =>
      tx.messageLog.create({
        data: {
          tenantId: tenantB.tenantId,
          toPhoneNumber: '5511900000000',
          body: 'linha forjada',
          idempotencyKey: `r6-forjada-${randomUUID()}`,
        },
      }),
    );
    await expect(attempt).rejects.toThrow(/row-level security/i);
  });

  it('o Tenant A não altera nem apaga a linha do Tenant B', async () => {
    const updated = await prismaAs(tenantA.tenantId).forTenant((tx) =>
      tx.messageLog.updateMany({ where: { idempotencyKey: keyOfB }, data: { body: 'adulterada' } }),
    );
    const deleted = await prismaAs(tenantA.tenantId).forTenant((tx) =>
      tx.messageLog.deleteMany({ where: { idempotencyKey: keyOfB } }),
    );
    expect(updated.count).toBe(0);
    expect(deleted.count).toBe(0);

    const intact = await fixturePrisma.messageLog.findUnique({ where: { idempotencyKey: keyOfB } });
    expect(intact?.body).toBe('Mensagem confidencial do Tenant B');
  });

  it('sem app.tenant_id na transação, a role da aplicação não enxerga nenhuma linha', async () => {
    const rows = await client.messageLog.findMany({ where: { idempotencyKey: { in: [keyOfA, keyOfB] } } });
    expect(rows).toEqual([]);
  });
});

describe('[CRÍTICO — R6] clinic_subscription — sem RLS por desenho, isolada pela aplicação', () => {
  it('cada Tenant vê só a própria assinatura', async () => {
    const a = await request(app.getHttpServer()).get('/api/v1/subscription').set('Authorization', `Bearer ${tokenA}`);
    const b = await request(app.getHttpServer()).get('/api/v1/subscription').set('Authorization', `Bearer ${tokenB}`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.plan).toBe('professional');
    expect(b.body.plan).toBe('enterprise');
  });

  it('uma alteração de plano feita pelo Tenant A não toca a assinatura do Tenant B', async () => {
    const upgrade = await request(app.getHttpServer())
      .post('/api/v1/subscription/upgrade')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ newPlan: 'business' });
    expect(upgrade.status).toBe(201);
    expect(upgrade.body.plan).toBe('business');

    const subscriptionOfB = await fixturePrisma.clinicSubscription.findUniqueOrThrow({ where: { id: tenantB.subscriptionId } });
    expect(subscriptionOfB.plan).toBe('enterprise');
  });

  it('a rota não aceita tenantId vindo do cliente (campo extra é rejeitado pela validação)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/subscription/upgrade')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ newPlan: 'enterprise', tenantId: tenantB.tenantId });
    expect(res.status).toBe(400);

    const subscriptionOfB = await fixturePrisma.clinicSubscription.findUniqueOrThrow({ where: { id: tenantB.subscriptionId } });
    expect(subscriptionOfB.plan).toBe('enterprise');
  });
});
