import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { uniquePastSlot } from './support/unique-slot';
import { attendedSession } from './support/attended-session';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * [CRÍTICO #4-7] Modelo de Cobrança Agregada — Módulo 09.
 * Fonte: docs/09-Testes/01-Testes-Criticos.md.
 *
 * Depende de uma Sessão real (billing_session.session_id é FK para
 * session.id). K2-b: ela nasce do registro da realização
 * (RegistrarRealizacaoUseCase), não mais da confirmação.
 *
 * Infraestrutura de teste (Etapa 1 da correção de estabilidade da Suíte
 * Crítica): Tenant/Terapeuta/Paciente dedicados, não mais o Tenant A
 * seedado compartilhado — elimina o acúmulo indefinido de Appointment.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let fixture: DedicatedFixture;

/** K2-b — sessão a cobrar: consulta que já aconteceu, com a realização registrada (confirmar não cria sessão). */
async function createConfirmedSession(scheduledAt: string = uniquePastSlot()): Promise<string> {
  const { appointmentId, sessionId } = await attendedSession(app, fixture.token as string, {
    patientId: fixture.patientId,
    therapistId: fixture.therapistId,
    scheduledAt,
  });
  fixture.appointmentIds.push(appointmentId);
  fixture.sessionIds.push(sessionId);
  return sessionId;
}

describe('[CRÍTICO #4] Cobrança por sessão avulsa: 1 session gera exatamente 1 billing (N=1)', () => {
  it('cria a billing vinculada a exatamente 1 sessão', async () => {
    const sessionId = await createConfirmedSession();

    const res = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ patientId: fixture.patientId, amount: 400, dueDate: '2026-09-08', sessionIds: [sessionId] });

    expect(res.status).toBe(201);
    fixture.billingIds.push(res.body.id);
    const linkedCount = await fixturePrisma.billingSession.count({ where: { billingId: res.body.id } });
    expect(linkedCount).toBe(1);
  });
});

describe('[CRÍTICO #5] Cobrança semanal: N sessions da mesma semana geram exatamente 1 billing', () => {
  it('agrega 3 sessões da mesma semana em 1 única billing', async () => {
    const sessionIds = [await createConfirmedSession(), await createConfirmedSession(), await createConfirmedSession()];

    const res = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ patientId: fixture.patientId, amount: 1200, dueDate: '2026-09-15', sessionIds });

    expect(res.status).toBe(201);
    fixture.billingIds.push(res.body.id);
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
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ patientId: fixture.patientId, amount: 1600, dueDate: '2026-11-05', sessionIds });

    expect(res.status).toBe(201);
    fixture.billingIds.push(res.body.id);
    const linkedCount = await fixturePrisma.billingSession.count({ where: { billingId: res.body.id } });
    expect(linkedCount).toBe(4);
  });
});

describe('[CRÍTICO #7] Uma session já vinculada a uma billing em aberto não pode entrar em uma segunda billing', () => {
  it('rejeita com erro de regra de negócio (não 500 genérico) ao reusar a mesma sessão', async () => {
    const sessionId = await createConfirmedSession();

    const first = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ patientId: fixture.patientId, amount: 400, dueDate: '2026-09-09', sessionIds: [sessionId] });
    expect(first.status).toBe(201);
    fixture.billingIds.push(first.body.id);

    const second = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ patientId: fixture.patientId, amount: 400, dueDate: '2026-09-09', sessionIds: [sessionId] });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('SESSION_ALREADY_BILLED');
    expect(second.body.error.category).toBe('business_rule');
    // second nunca foi criada (409) — nada a registrar para cleanup.
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
  fixture = await createDedicatedFixture(fixturePrisma, 'BILLAGG', {
    withActiveSubscription: true,
    withAvailabilityCalendar: true,
  });
  await createDedicatedUserAndLogin(fixturePrisma, app, fixture, 'BILLAGG');
});

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await fixturePrisma.$disconnect();
  await app.close();
});
