import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BillingStatus, PrismaClient } from '@prisma/client';
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
 *
 * Tarefa 05 da auditoria — "em atraso" passou a ser calculado pelo
 * vencimento (Billing.isOverdue). Antes este arquivo travava a contagem em
 * `status = atrasada`, estado a que nenhum fluxo chega: o indicador ficava
 * em zero para sempre. As cobranças do Tenant A cobrem todos os estados e
 * os dois lados do vencimento; a lista de cobranças (`overdue` em cada
 * item) tem de concordar com a contagem do resumo.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let tenantA: DedicatedFixture;
let tenantB: DedicatedFixture;

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY_IN_MS).toISOString().slice(0, 10);
// Longe da virada do dia de propósito: a fronteira exata (o dia do
// vencimento ainda está em dia) é travada no teste unitário da entidade.
const LAST_MONTH = isoDate(-30);
const TWO_DAYS_AGO = isoDate(-2);
const TOMORROW = isoDate(1);
const NEXT_MONTH = isoDate(30);

/** Tenant A: [valor, estado, vencimento, está em atraso?]. Os valores são únicos para identificar cada cobrança na lista. */
const TENANT_A_BILLINGS: Array<[number, BillingStatus, string, boolean]> = [
  [400, 'atrasada', LAST_MONTH, true], // pelo estado, como já era
  [1200, 'criada', LAST_MONTH, true], // pelo vencimento
  [300, 'enviada', TWO_DAYS_AGO, true],
  [80, 'pendente', LAST_MONTH, true],
  [70, 'visualizada', LAST_MONTH, true],
  [150, 'criada', TOMORROW, false], // ainda não venceu
  [220, 'enviada', NEXT_MONTH, false],
  [5000, 'quitada', LAST_MONTH, false], // paga: nunca em atraso
  [7000, 'cancelada', LAST_MONTH, false],
  [90, 'negociada', LAST_MONTH, false], // fora da contagem, como já estava
  [60, 'escalada', LAST_MONTH, false],
];
const OVERDUE_AMOUNTS_A = TENANT_A_BILLINGS.filter(([, , , overdue]) => overdue).map(([amount]) => amount);
const PENDING_TOTAL_A = TENANT_A_BILLINGS.filter(([, status]) => status !== 'quitada' && status !== 'cancelada').reduce((sum, [amount]) => sum + amount, 0);

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

async function createBillingWithStatus(fixture: DedicatedFixture, amount: number, status: BillingStatus, dueDate: string = LAST_MONTH): Promise<string> {
  const sessionId = await createConfirmedSession(fixture);
  const res = await request(app.getHttpServer())
    .post('/api/v1/billings')
    .set('Authorization', `Bearer ${fixture.token}`)
    .send({ patientId: fixture.patientId, amount, dueDate, sessionIds: [sessionId] });
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

const summaryOf = (fixture: DedicatedFixture) => request(app.getHttpServer()).get('/api/v1/dashboard/summary').set('Authorization', `Bearer ${fixture.token}`);

async function billingsOf(fixture: DedicatedFixture): Promise<Array<{ amount: number; state: string; overdue: boolean }>> {
  const res = await request(app.getHttpServer()).get('/api/v1/billings?limit=100').set('Authorization', `Bearer ${fixture.token}`);
  expect(res.status).toBe(200);
  return res.body.data;
}

describe('[Epic 11] GET /dashboard/summary — agregações e isolamento multi-tenant', () => {
  it('Tenant A: activePatients conta somente pacientes Ativo, ignorando outros estados', async () => {
    const res = await summaryOf(tenantA);

    expect(res.status).toBe(200);
    // 2 pacientes extras criados com state: 'Ativo'; o paciente principal da
    // fixture fica no default 'Novo' e não deve ser contado.
    expect(res.body.activePatients).toBe(2);
  });

  it('Tenant A: overdueBillings conta o estado atrasada e as cobranças que aguardam pagamento com o vencimento passado', async () => {
    const res = await summaryOf(tenantA);

    expect(res.status).toBe(200);
    // atrasada + criada, enviada, pendente e visualizada vencidas. Ficam fora:
    // as que ainda não venceram, quitada, cancelada, negociada e escalada.
    expect(res.body.overdueBillings).toBe(OVERDUE_AMOUNTS_A.length);
    expect(res.body.overdueBillings).toBe(5);
  });

  it('Tenant A: a lista de cobranças marca como em atraso exatamente as que o resumo conta', async () => {
    const [summary, billings] = await Promise.all([summaryOf(tenantA), billingsOf(tenantA)]);

    const flagged = billings.filter((billing) => billing.overdue).map((billing) => billing.amount);
    expect(flagged.sort((a, b) => a - b)).toEqual([...OVERDUE_AMOUNTS_A].sort((a, b) => a - b));
    expect(summary.body.overdueBillings).toBe(flagged.length);
  });

  it('Tenant A: cobrança quitada ou cancelada nunca aparece em atraso, mesmo com o vencimento antigo', async () => {
    const billings = await billingsOf(tenantA);

    const closed = billings.filter((billing) => billing.state === 'Quitada' || billing.state === 'Cancelada');
    expect(closed).toHaveLength(2);
    expect(closed.every((billing) => billing.overdue === false)).toBe(true);
  });

  it('Tenant A: estar em atraso é só leitura — o estado gravado da cobrança vencida não muda', async () => {
    const billings = await billingsOf(tenantA);

    expect(billings.find((billing) => billing.amount === 1200)).toMatchObject({ state: 'Criada', overdue: true });
    expect(billings.find((billing) => billing.amount === 300)).toMatchObject({ state: 'Enviada', overdue: true });
    expect(await fixturePrisma.billing.count({ where: { tenantId: tenantA.tenantId, status: 'atrasada' } })).toBe(1);
  });

  it('Tenant A: totalPending soma os estados elegíveis e exclui quitada e cancelada', async () => {
    const res = await summaryOf(tenantA);

    expect(res.status).toBe(200);
    // Tudo menos quitada (5000) e cancelada (7000). A regra não mudou.
    expect(res.body.totalPending).toBe(PENDING_TOTAL_A);
    expect(res.body.totalPending).toBe(2570);
  });

  it('Tenant B possui indicadores diferentes de Tenant A (prova de isolamento)', async () => {
    const resB = await summaryOf(tenantB);

    expect(resB.status).toBe(200);
    expect(resB.body.activePatients).toBe(5);
    // atrasada (250) + atrasada (850); a criada de 640 ainda não venceu.
    expect(resB.body.overdueBillings).toBe(2);
    // 250 + 850 + 640 = 1740; quitada (3000) e cancelada (4000) excluídas.
    expect(resB.body.totalPending).toBe(1740);
  });

  it('Tenant A não enxerga os dados de Tenant B e vice-versa', async () => {
    const resA = await summaryOf(tenantA);
    const resB = await summaryOf(tenantB);

    expect(resA.body).not.toEqual(resB.body);
    expect(resA.body).toEqual({ activePatients: 2, overdueBillings: 5, totalPending: 2570 });
    expect(resB.body).toEqual({ activePatients: 5, overdueBillings: 2, totalPending: 1740 });
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
  for (const [amount, status, dueDate] of TENANT_A_BILLINGS) {
    await createBillingWithStatus(tenantA, amount, status, dueDate);
  }

  await createActivePatients(tenantB, 5);
  await createBillingWithStatus(tenantB, 250, 'atrasada');
  await createBillingWithStatus(tenantB, 850, 'atrasada');
  await createBillingWithStatus(tenantB, 3000, 'quitada');
  await createBillingWithStatus(tenantB, 4000, 'cancelada');
  await createBillingWithStatus(tenantB, 640, 'criada', TOMORROW);
}, 60_000); // 16 cobranças, cada uma com consulta e sessão criadas pela API

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, tenantA);
  await cleanupDedicatedFixture(fixturePrisma, tenantB);
  await fixturePrisma.$disconnect();
  await app.close();
});
