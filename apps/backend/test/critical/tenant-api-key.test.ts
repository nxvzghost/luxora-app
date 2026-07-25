import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { TenantApiKeyGuard } from '@api/subscription/tenant-api-key.guard';
import { PrismaClinicSubscriptionRepository } from '@infrastructure/database/repositories/prisma-clinic-subscription.repository';
import { TenantContext } from '@shared/tenant-context';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * [PD-003] Acesso à API por Tenant — Módulo 17.
 *
 * Valida contra Postgres real (não mocks): geração de chave via HTTP real,
 * a policy `api_key_lookup_by_hash` (RLS) localizando o Tenant certo pelo
 * hash, isolamento entre Tenants, e o gate de plano (Business/Enterprise
 * apenas) reavaliado a cada uso — não só na geração.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let fixtureBusiness: DedicatedFixture;
let fixtureProfessional: DedicatedFixture;
let generatedKey: string;

/**
 * AD-034 — client compartilhado entre os testes que precisam de uma
 * PrismaService fora do app bootstrapado (testes abaixo que exercitam
 * TenantApiKeyGuard diretamente). Antes, cada um desses testes abria seu
 * próprio `new PrismaClientProvider()` — e PrismaClientProvider ESTENDE
 * PrismaClient diretamente, então cada instância nova é um PrismaClient
 * novo, com seu próprio pool de conexões, nunca compartilhado. Com
 * maxWorkers=6 arquivos de test/critical rodando em paralelo, isso
 * multiplicava a pressão agregada de conexões no Postgres e já causou
 * timeout de hook nesta suíte (10000ms, ver AD-034).
 *
 * Compartilhar este client entre os testes é seguro porque:
 * - TenantContext continua isolado por teste — cada teste abaixo cria sua
 *   própria instância (`new TenantContext()`), nunca reaproveitada.
 * - O isolamento de RLS depende de SET LOCAL dentro de uma transação
 *   (PrismaService.forTenant()/forAuthLookup()), nunca de qual objeto
 *   PrismaClient está por baixo — mesmo raciocínio que já torna
 *   PrismaClientProvider seguro como singleton em produção (ver o
 *   comentário do próprio arquivo do provider).
 * - Só a infraestrutura de conexão é compartilhada — nenhum estado de
 *   aplicação (TenantContext, resultado de query) atravessa de um teste
 *   para o outro; cada teste monta seu próprio PrismaService/guard por cima
 *   do mesmo client.
 */
let sharedClient: PrismaClientProvider;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

function fakeContext(headerValue: string | undefined) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers: headerValue ? { 'x-api-key': headerValue } : {} }) }),
  } as never;
}

describe('[PD-003] Acesso à API por Tenant', () => {
  it('POST /subscription/api-key gera uma chave real para um Tenant Business', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/subscription/api-key')
      .set('Authorization', `Bearer ${fixtureBusiness.token}`);

    expect(res.status).toBe(201);
    expect(typeof res.body.apiKey).toBe('string');
    expect(res.body.apiKey).toHaveLength(64);
    generatedKey = res.body.apiKey;
  });

  it('rejeita a geração de chave para um Tenant Professional, com API_ACCESS_NOT_INCLUDED', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/subscription/api-key')
      .set('Authorization', `Bearer ${fixtureProfessional.token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('API_ACCESS_NOT_INCLUDED');
  });

  it('a chave gerada resolve o Tenant certo através da policy de bypass de RLS (não mockado)', async () => {
    const tenantContext = new TenantContext();
    const prisma = new PrismaService(sharedClient, tenantContext);
    const subscriptionRepo = new PrismaClinicSubscriptionRepository(sharedClient);
    const guard = new TenantApiKeyGuard(prisma, subscriptionRepo, tenantContext);

    const result = await guard.canActivate(fakeContext(generatedKey));
    expect(result).toBe(true);
    expect(tenantContext.tenantId).toBe(fixtureBusiness.tenantId);
    expect(tenantContext.userId).toBeNull();
  });

  it('uma chave inexistente é rejeitada (UnauthorizedException), sem vazar para nenhum Tenant', async () => {
    const tenantContext = new TenantContext();
    const prisma = new PrismaService(sharedClient, tenantContext);
    const subscriptionRepo = new PrismaClinicSubscriptionRepository(sharedClient);
    const guard = new TenantApiKeyGuard(prisma, subscriptionRepo, tenantContext);

    await expect(guard.canActivate(fakeContext('chave-que-nunca-existiu'))).rejects.toThrow(UnauthorizedException);
    expect(tenantContext.isInitialized).toBe(false);
  });

  it('bypass de RLS da API key não vaza para uma transação forTenant() seguinte, mesma conexão pooled', async () => {
    const tenantContext = new TenantContext();
    const prisma = new PrismaService(sharedClient, tenantContext);

    const foundDuringLookup = await prisma.forAuthLookup((tx) =>
      tx.tenantApiKey.findMany({ where: { tenantId: fixtureBusiness.tenantId } }),
    );
    expect(foundDuringLookup.length).toBeGreaterThan(0);

    // Contexto de um Tenant DIFERENTE (Professional) — forTenant() comum
    // nunca deveria enxergar a tenant_api_key do Tenant Business, mesmo a
    // policy de bypass existindo na tabela e a conexão sendo reaproveitada
    // do pool logo depois de uma transação que ativou o bypass. Usar o
    // mesmo sharedClient aqui torna este teste MAIS rigoroso, não menos —
    // prova ausência de vazamento sobre uma conexão genuinamente
    // reaproveitada entre vários testes, não uma recém-criada.
    tenantContext.set(fixtureProfessional.tenantId, 'admin-professional');
    const leaked = await prisma.forTenant((tx) => tx.tenantApiKey.findMany({ where: { tenantId: fixtureBusiness.tenantId } }));
    expect(leaked).toHaveLength(0);
  });

  it('mesmo com chave válida, um rebaixamento de plano para Professional depois da geração bloqueia o uso (ForbiddenException)', async () => {
    await fixturePrisma.clinicSubscription.update({
      where: { tenantId: fixtureBusiness.tenantId },
      data: { plan: 'professional' },
    });

    const tenantContext = new TenantContext();
    const prisma = new PrismaService(sharedClient, tenantContext);
    const subscriptionRepo = new PrismaClinicSubscriptionRepository(sharedClient);
    const guard = new TenantApiKeyGuard(prisma, subscriptionRepo, tenantContext);

    await expect(guard.canActivate(fakeContext(generatedKey))).rejects.toThrow(ForbiddenException);

    // Restaura para não afetar a limpeza/expectativas de outros testes deste arquivo.
    await fixturePrisma.clinicSubscription.update({
      where: { tenantId: fixtureBusiness.tenantId },
      data: { plan: 'business' },
    });
  });
});

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();

  sharedClient = new PrismaClientProvider();
  await sharedClient.$connect();

  app = await bootstrapTestApp();

  fixtureBusiness = await createDedicatedFixture(fixturePrisma, 'APIKEYBIZ', { withActiveSubscription: true });
  await fixturePrisma.clinicSubscription.update({ where: { tenantId: fixtureBusiness.tenantId }, data: { plan: 'business' } });
  await createDedicatedUserAndLogin(fixturePrisma, app, fixtureBusiness, 'APIKEYBIZ');

  fixtureProfessional = await createDedicatedFixture(fixturePrisma, 'APIKEYPRO', { withActiveSubscription: true });
  await createDedicatedUserAndLogin(fixturePrisma, app, fixtureProfessional, 'APIKEYPRO');
});

afterAll(async () => {
  if (fixtureBusiness || fixtureProfessional) {
    await fixturePrisma.tenantApiKey.deleteMany({
      where: { tenantId: { in: [fixtureBusiness?.tenantId, fixtureProfessional?.tenantId].filter((id): id is string => Boolean(id)) } },
    });
  }
  await cleanupDedicatedFixture(fixturePrisma, fixtureBusiness);
  await cleanupDedicatedFixture(fixturePrisma, fixtureProfessional);
  await sharedClient?.$disconnect();
  await fixturePrisma?.$disconnect();
  await app?.close();
});
