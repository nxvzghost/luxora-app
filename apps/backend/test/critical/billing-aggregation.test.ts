import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { loginAs, TENANT_A_ADMIN_EMAIL } from './support/login-helper';
import { uniqueSlot } from './support/unique-slot';

/**
 * [CRÍTICO #4-7] Modelo de Cobrança Agregada — Módulo 09.
 * Fonte: docs/09-Testes/01-Testes-Criticos.md.
 *
 * Depende de ConfirmarConsultaUseCase criar a Sessão real (gap fechado
 * nesta mesma revisão — ver gerenciar-consulta.use-case.ts) — sem isso,
 * nenhum destes cenários é alcançável pela API real (billing_session.session_id
 * é FK para session.id).
 */

let app: INestApplication;
let token: string;
let patientId: string;
let therapistId: string;

// Arrange/verificação de dados apenas — luxora_app (role real) está sujeita
// a RLS, e session/billing_session são protegidas; a asserção que importa
// de verdade é a resposta HTTP em si (respeitando RLS via TenantContext do
// próprio token), isto aqui só confirma a contagem de linhas no banco.
function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}
const fixturePrisma = new PrismaClient({
  datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } },
});

async function createConfirmedSession(scheduledAt: string = uniqueSlot()): Promise<string> {
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
  return session.id;
}

describe('[CRÍTICO #4] Cobrança por sessão avulsa: 1 session gera exatamente 1 billing (N=1)', () => {
  it('cria a billing vinculada a exatamente 1 sessão', async () => {
    const sessionId = await createConfirmedSession();

    const res = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${token}`)
      .send({ patientId, amount: 400, dueDate: '2026-09-08', sessionIds: [sessionId] });

    expect(res.status).toBe(201);
    const linkedCount = await fixturePrisma.billingSession.count({ where: { billingId: res.body.id } });
    expect(linkedCount).toBe(1);
  });
});

describe('[CRÍTICO #5] Cobrança semanal: N sessions da mesma semana geram exatamente 1 billing', () => {
  it('agrega 3 sessões da mesma semana em 1 única billing', async () => {
    const sessionIds = [await createConfirmedSession(), await createConfirmedSession(), await createConfirmedSession()];

    const res = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${token}`)
      .send({ patientId, amount: 1200, dueDate: '2026-09-15', sessionIds });

    expect(res.status).toBe(201);
    const linkedCount = await fixturePrisma.billingSession.count({ where: { billingId: res.body.id } });
    expect(linkedCount).toBe(3);
  });
});

describe('[CRÍTICO #6] Cobrança mensal: N sessions do mesmo mês geram exatamente 1 billing', () => {
  it('agrega 4 sessões semanais do mesmo mês em 1 única billing', async () => {
    const sessionIds = [
      await createConfirmedSession(),
      await createConfirmedSession(),
      await createConfirmedSession(),
      await createConfirmedSession(),
    ];

    const res = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${token}`)
      .send({ patientId, amount: 1600, dueDate: '2026-11-05', sessionIds });

    expect(res.status).toBe(201);
    const linkedCount = await fixturePrisma.billingSession.count({ where: { billingId: res.body.id } });
    expect(linkedCount).toBe(4);
  });
});

describe('[CRÍTICO #7] Uma session já vinculada a uma billing em aberto não pode entrar em uma segunda billing', () => {
  it('rejeita com erro de regra de negócio (não 500 genérico) ao reusar a mesma sessão', async () => {
    const sessionId = await createConfirmedSession();

    const first = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${token}`)
      .send({ patientId, amount: 400, dueDate: '2026-09-09', sessionIds: [sessionId] });
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${token}`)
      .send({ patientId, amount: 400, dueDate: '2026-09-09', sessionIds: [sessionId] });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('SESSION_ALREADY_BILLED');
    expect(second.body.error.category).toBe('business_rule');
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
