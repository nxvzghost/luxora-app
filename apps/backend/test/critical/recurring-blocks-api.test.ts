import { randomInt } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { bootstrapTestApp } from './support/bootstrap-app';
import { loginAs, TENANT_A_ADMIN_EMAIL } from './support/login-helper';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * PD-001 Fase 2, C5 — API HTTP de RecurringBlock (Criar + Listar), ponta a
 * ponta: guards reais, ValidationPipe real, ExceptionFilter real — mesmo
 * padrão de bootstrapTestApp() já usado pelos demais Testes Críticos de API.
 *
 * Não cria Tenant/Therapist/Patient dedicados para os testes de Criar/Listar
 * "felizes": CriarRecurringBlockUseCase não consulta o Motor de
 * Disponibilidade, então não há a mesma sensibilidade a fixture poluída que
 * causou a instabilidade investigada na C3/C4 — reusa o admin e o primeiro
 * Patient/Therapist já seedados do Tenant A, mesmo padrão já usado por
 * appointment-concurrency.test.ts/billing-aggregation.test.ts. Asserções
 * evitam contagem exata (usam "contém"/"todos pertencem a").
 *
 * O teste de isolamento entre tenants NÃO usa o Tenant B seedado: o seed
 * deixa Tenant B deliberadamente sem assinatura ativa (ver comentário em
 * prisma/seed.ts), especificamente para exercitar SubscriptionAccessGuard —
 * autenticar como Tenant B aqui sempre resultaria em 403 antes mesmo de
 * chegar no Controller, o que provaria o guard de assinatura, não o
 * isolamento de RecurringBlock. Por isso, esse teste cria seu próprio Tenant
 * dedicado, com assinatura ativa e usuário próprio, para provar isolamento
 * de verdade através da cadeia HTTP completa — sem mutar o Tenant B
 * compartilhado, que outros testes já dependem de continuar bloqueado.
 */

let app: INestApplication;
let tokenA: string;
let patientId: string;
let therapistId: string;

let fixturePrisma: PrismaClient;
let dedicatedFixture: DedicatedFixture | undefined;
let dedicatedTenantToken: string;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

// Mesmo raciocínio de test/critical/support/unique-slot.ts: afasta a data
// candidata o suficiente para não colidir com nenhuma outra suíte.
const ANCHOR_DAYS_AHEAD = randomInt(30, 9970);
function dateAt(daysFromAnchor: number): string {
  const date = new Date();
  date.setDate(date.getDate() + ANCHOR_DAYS_AHEAD + daysFromAnchor);
  date.setHours(14, 0, 0, 0);
  return date.toISOString();
}

beforeAll(async () => {
  app = await bootstrapTestApp();
  tokenA = await loginAs(app, TENANT_A_ADMIN_EMAIL);

  const patientsRes = await request(app.getHttpServer())
    .get('/api/v1/patients')
    .set('Authorization', `Bearer ${tokenA}`);
  patientId = patientsRes.body.data[0].id;

  const therapistsRes = await request(app.getHttpServer())
    .get('/api/v1/therapists')
    .set('Authorization', `Bearer ${tokenA}`);
  therapistId = therapistsRes.body.data[0].id;

  // Tenant totalmente dedicado a este arquivo, com assinatura ativa — só
  // para o teste de isolamento (não mistura com o Tenant B seedado).
  //
  // AD-034: antes, este arquivo criava Tenant/ClinicSubscription/User "na
  // mão" e fazia sua própria limpeza manual em afterAll — lógica duplicada
  // da já existente em dedicated-fixture.ts, e frágil (se qualquer linha
  // acima deste bloco no beforeAll lançasse, o afterAll tentava acessar
  // `fixturePrisma`/`dedicatedTenantId` undefined, mascarando o erro real
  // com um TypeError secundário). Migrado para createDedicatedFixture()/
  // cleanupDedicatedFixture() — mesmo mecanismo oficial usado pelos demais
  // arquivos, já resiliente a beforeAll parcial.
  fixturePrisma = new PrismaClient({
    datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } },
  });
  await fixturePrisma.$connect();

  dedicatedFixture = await createDedicatedFixture(fixturePrisma, 'C5API', { withActiveSubscription: true });
  dedicatedTenantToken = await createDedicatedUserAndLogin(fixturePrisma, app, dedicatedFixture, 'C5API');
});

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, dedicatedFixture);
  await fixturePrisma?.$disconnect();
  await app?.close();
});

describe('RecurringBlocksController — POST /api/v1/recurring-blocks', () => {
  it('cria um RecurringBlock real e retorna 201 com os dados persistidos', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/recurring-blocks')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        patientId,
        therapistId,
        firstOccurrence: dateAt(0),
        intervalDays: 7,
        modality: 'presencial',
        renewalMode: 'automatic',
      });

    expect(res.status).toBe(201);
    expect(res.body.patientId).toBe(patientId);
    expect(res.body.therapistId).toBe(therapistId);
    expect(res.body.intervalDays).toBe(7);
    expect(res.body.modality).toBe('presencial');
    expect(res.body.renewalMode).toBe('automatic');
    expect(res.body.id).toBeTruthy();
  });

  it('rejeita com 401 sem token de autenticação', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/recurring-blocks')
      .send({
        patientId,
        therapistId,
        firstOccurrence: dateAt(0),
        intervalDays: 7,
        modality: 'presencial',
        renewalMode: 'automatic',
      });
    expect(res.status).toBe(401);
  });

  it('rejeita com 400 quando intervalDays está ausente (validação do DTO)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/recurring-blocks')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        patientId,
        therapistId,
        firstOccurrence: dateAt(0),
        modality: 'presencial',
        renewalMode: 'automatic',
      });
    expect(res.status).toBe(400);
  });

  it('rejeita com 400 quando modality tem valor inválido (validação do DTO)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/recurring-blocks')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        patientId,
        therapistId,
        firstOccurrence: dateAt(0),
        intervalDays: 7,
        modality: 'presencial-invalido',
        renewalMode: 'automatic',
      });
    expect(res.status).toBe(400);
  });
});

describe('RecurringBlocksController — GET /api/v1/recurring-blocks', () => {
  it('lista somente os blocos do therapistId informado, todos pertencentes ao Tenant autenticado', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/recurring-blocks')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        patientId,
        therapistId,
        firstOccurrence: dateAt(100),
        intervalDays: 7,
        modality: 'online',
        renewalMode: 'manual',
      });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/recurring-blocks?therapistId=${therapistId}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.data.every((b: { therapistId: string }) => b.therapistId === therapistId)).toBe(true);
    expect(res.body.data.map((b: { id: string }) => b.id)).toContain(created.body.id);
  });

  it('isolamento entre tenants: um Tenant diferente, autenticado de verdade, nunca vê um RecurringBlock do Tenant A, mesmo pedindo o therapistId real do Tenant A', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/recurring-blocks')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        patientId,
        therapistId,
        firstOccurrence: dateAt(200),
        intervalDays: 7,
        modality: 'presencial',
        renewalMode: 'automatic',
      });

    const resAsOtherTenant = await request(app.getHttpServer())
      .get(`/api/v1/recurring-blocks?therapistId=${therapistId}`)
      .set('Authorization', `Bearer ${dedicatedTenantToken}`);

    expect(resAsOtherTenant.status).toBe(200);
    expect(resAsOtherTenant.body.data.map((b: { id: string }) => b.id)).not.toContain(created.body.id);
  });

  it('rejeita com 401 sem token de autenticação', async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/recurring-blocks?therapistId=${therapistId}`);
    expect(res.status).toBe(401);
  });
});
