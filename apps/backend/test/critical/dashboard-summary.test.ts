import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { uniqueSlot } from './support/unique-slot';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * [Epic 11] GET /dashboard/summary — Dois Tenants dedicados (A e B) com
 * dados propositalmente distintos, para provar tanto as regras de
 * agregação (activePatients/overdueBillings/totalPending) quanto o
 * isolamento multi-tenant. Mesmo padrão de infraestrutura de
 * billing-aggregation.test.ts (fixtures dedicadas, API HTTP real,
 * fixturePrisma só para setup/teardown direto do que não tem caminho HTTP).
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let tenantA: DedicatedFixture;
let tenantB: DedicatedFixture;

async function createConfirmedSession(fixture: DedicatedFixture): Promise<string> {
  const apptRes = await request(app.getHttpServer())
    .post('/api/v1/appointments')
    .set('Authorization', `Bearer ${fixture.token}`)
    .send({ patientId: fixture.patientId, therapistId: fixture.therapistId, scheduledAt: uniqueSlot(), modality: 'presencial' });
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

async function createBillingWithStatus(
  fixture: DedicatedFixture,
  amount: number,
  status: 'atrasada' | 'criada' | 'quitada' | 'cancelada',
): Promise<string> {
  const sessionId = await createConfirmedSession(fixture);
  const res = await request(app.getHttpServer())
    .post('/api/v1/billings')
    .set('Authorization', `Bearer ${fixture.token}`)
    .send({ patientId: fixture.patientId, amount, dueDate: '2026-09-08', sessionIds: [sessionId] });
  expect(res.status).toBe(201);
  fixture.billingIds.push(res.body.id);

  if (status !== 'criada') {
    await fixturePrisma.billing.update({ where: { id: res.body.id }, data: { status } });
  }
  return res.body.id;
}

async function createActivePatients(fixture: DedicatedFixture, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const patient = await fixturePrisma.patient.create({
      data: { tenantId: fixture.tenantId, name: `Paciente Ativo Dashboard ${i}`, phone: '11999999999', state: 'Ativo' },
    });
    fixture.patientIds.push(patient.id);
  }
}

describe('[Epic 11] GET /dashboard/summary — agregações e isolamento multi-tenant', () => {
  it('Tenant A: activePatients conta somente pacientes Ativo, ignorando outros estados', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/dashboard/summary')
      .set('Authorization', `Bearer ${tenantA.token}`);

    expect(res.status).toBe(200);
    // 2 pacientes extras criados com state: 'Ativo'; o paciente principal da
    // fixture fica no default 'Novo' e não deve ser contado.
    expect(res.body.activePatients).toBe(2);
  });

  it('Tenant A: overdueBillings conta somente cobranças com status atrasada', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/dashboard/summary')
      .set('Authorization', `Bearer ${tenantA.token}`);

    expect(res.status).toBe(200);
    expect(res.body.overdueBillings).toBe(1);
  });

  it('Tenant A: totalPending soma os estados elegíveis e exclui quitada e cancelada', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/dashboard/summary')
      .set('Authorization', `Bearer ${tenantA.token}`);

    expect(res.status).toBe(200);
    // atrasada (400) + criada (1200) = 1600; quitada (5000) e cancelada (7000) excluídas.
    expect(res.body.totalPending).toBe(1600);
  });

  it('Tenant B possui indicadores diferentes de Tenant A (prova de isolamento)', async () => {
    const resB = await request(app.getHttpServer())
      .get('/api/v1/dashboard/summary')
      .set('Authorization', `Bearer ${tenantB.token}`);

    expect(resB.status).toBe(200);
    expect(resB.body.activePatients).toBe(5);
    expect(resB.body.overdueBillings).toBe(2);
    // atrasada (250) + atrasada (850) = 1100; quitada (3000) e cancelada (4000) excluídas.
    expect(resB.body.totalPending).toBe(1100);
  });

  it('Tenant A não enxerga os dados de Tenant B e vice-versa', async () => {
    const resA = await request(app.getHttpServer())
      .get('/api/v1/dashboard/summary')
      .set('Authorization', `Bearer ${tenantA.token}`);
    const resB = await request(app.getHttpServer())
      .get('/api/v1/dashboard/summary')
      .set('Authorization', `Bearer ${tenantB.token}`);

    expect(resA.body).not.toEqual(resB.body);
    expect(resA.body).toEqual({ activePatients: 2, overdueBillings: 1, totalPending: 1600 });
    expect(resB.body).toEqual({ activePatients: 5, overdueBillings: 2, totalPending: 1100 });
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

  tenantA = await createDedicatedFixture(fixturePrisma, 'DASHA', { withActiveSubscription: true, withAvailabilityCalendar: true });
  await createDedicatedUserAndLogin(fixturePrisma, app, tenantA, 'DASHA');

  tenantB = await createDedicatedFixture(fixturePrisma, 'DASHB', { withActiveSubscription: true, withAvailabilityCalendar: true });
  await createDedicatedUserAndLogin(fixturePrisma, app, tenantB, 'DASHB');

  await createActivePatients(tenantA, 2);
  await createBillingWithStatus(tenantA, 400, 'atrasada');
  await createBillingWithStatus(tenantA, 1200, 'criada');
  await createBillingWithStatus(tenantA, 5000, 'quitada');
  await createBillingWithStatus(tenantA, 7000, 'cancelada');

  await createActivePatients(tenantB, 5);
  await createBillingWithStatus(tenantB, 250, 'atrasada');
  await createBillingWithStatus(tenantB, 850, 'atrasada');
  await createBillingWithStatus(tenantB, 3000, 'quitada');
  await createBillingWithStatus(tenantB, 4000, 'cancelada');
});

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, tenantA);
  await cleanupDedicatedFixture(fixturePrisma, tenantB);
  await fixturePrisma.$disconnect();
  await app.close();
});
