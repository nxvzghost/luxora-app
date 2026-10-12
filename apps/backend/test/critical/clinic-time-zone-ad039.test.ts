import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { addCivilDays, civilDateIn, formatCivilDate } from '@domain/shared/time-zone';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';
import { clinicTimeAt } from '../support/clinic-time';

/**
 * AD-039 (ADR-0064) — fuso por clínica, ponta a ponta: app real, Postgres
 * real, pelas rotas que o painel e a secretária usam.
 *
 * Critérios de aceite cobertos aqui:
 *   - com o processo em qualquer fuso (o CI roda em UTC), a janela "09:00" de
 *     uma clínica de São Paulo oferece horários às 09:00 de lá;
 *   - uma clínica em outro fuso vê os próprios horários e o próprio dia, sem
 *     afetar as demais;
 *   - a cobrança está em dia durante todo o dia do vencimento da clínica, e o
 *     Dashboard e o Financeiro mostram a mesma contagem;
 *   - a clínica que já existia recebe o padrão sem intervenção.
 *
 * As fronteiras exatas de meia-noite, com o relógio controlado, estão nos
 * testes da entidade (test/unit/domain/billing) e do repositório
 * (test/integration/database/prisma-clinic-time-zone.test.ts). Aqui o
 * relógio é o de verdade; por isso os casos de atraso usam dois fusos que
 * NUNCA estão no mesmo dia (Kiritimati, UTC+14, e Pago Pago, UTC-11): a mesma
 * cobrança está em atraso em um e em dia no outro, a qualquer hora em que o
 * teste rode.
 */
let app: INestApplication;
let fixturePrisma: PrismaClient;
let saoPaulo: DedicatedFixture;
let manaus: DedicatedFixture;
let kiritimati: DedicatedFixture;
let pagoPago: DedicatedFixture;

const DAYS_AHEAD = 400;
const WORK_HOURS = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startTime: '09:00', endTime: '11:00', sessionDurationMinutes: 60 }));

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

const api = () => request(app.getHttpServer());
const as = (fixture: DedicatedFixture) => ({ Authorization: `Bearer ${fixture.token}` });

async function clinicIn(label: string, timeZone?: string): Promise<DedicatedFixture> {
  const fixture = await createDedicatedFixture(fixturePrisma, label, { withActiveSubscription: true, withClinicSettings: true });
  if (timeZone) {
    await fixturePrisma.clinicSettings.update({ where: { tenantId: fixture.tenantId }, data: { timeZone } });
  }
  await createDedicatedUserAndLogin(fixturePrisma, app, fixture, label);
  return fixture;
}

/** Define as janelas pela rota do painel — é ela que cria o calendário, com o fuso da clínica. */
async function setWorkHours(fixture: DedicatedFixture): Promise<void> {
  const response = await api().put(`/api/v1/therapists/${fixture.therapistId}/availability`).set(as(fixture)).send({ windows: WORK_HOURS });
  expect(response.status).toBe(200);
  const calendar = await fixturePrisma.availabilityCalendar.findUniqueOrThrow({ where: { therapistId: fixture.therapistId } });
  fixture.calendarId = calendar.id;
}

async function slotsOn(fixture: DedicatedFixture, timeZone: string): Promise<string[]> {
  const from = clinicTimeAt(DAYS_AHEAD, 0, 0, timeZone);
  const to = new Date(clinicTimeAt(DAYS_AHEAD + 1, 0, 0, timeZone).getTime() - 1);
  const response = await api()
    .get(`/api/v1/therapists/${fixture.therapistId}/availability`)
    .query({ from: from.toISOString(), to: to.toISOString() })
    .set(as(fixture));
  expect(response.status).toBe(200);
  return (response.body.data as Array<{ startsAt: string }>).map((slot) => slot.startsAt);
}

async function book(fixture: DedicatedFixture, scheduledAt: Date) {
  const response = await api()
    .post('/api/v1/appointments')
    .set(as(fixture))
    .send({ patientId: fixture.patientId, therapistId: fixture.therapistId, scheduledAt: scheduledAt.toISOString(), modality: 'presencial' });
  if (response.status === 201) fixture.appointmentIds.push(response.body.id);
  return response;
}

async function createBilling(fixture: DedicatedFixture, dueDate: string, amount: number): Promise<void> {
  const billing = await fixturePrisma.billing.create({
    data: { tenantId: fixture.tenantId, patientId: fixture.patientId, amount, dueDate: new Date(dueDate), status: 'enviada' },
  });
  fixture.billingIds.push(billing.id);
}

async function overdueByAmount(fixture: DedicatedFixture): Promise<Record<number, boolean>> {
  const response = await api().get('/api/v1/billings').set(as(fixture));
  expect(response.status).toBe(200);
  return Object.fromEntries((response.body.data as Array<{ amount: number; overdue: boolean }>).map((billing) => [billing.amount, billing.overdue]));
}

async function overdueCount(fixture: DedicatedFixture): Promise<number> {
  const response = await api().get('/api/v1/dashboard/summary').set(as(fixture));
  expect(response.status).toBe(200);
  return response.body.overdueBillings;
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  app = await bootstrapTestApp();

  saoPaulo = await clinicIn('AD039SP'); // sem dizer o fuso: como toda clínica que já existia
  manaus = await clinicIn('AD039AM', 'America/Manaus');
  kiritimati = await clinicIn('AD039KI', 'Pacific/Kiritimati');
  pagoPago = await clinicIn('AD039PP', 'Pacific/Pago_Pago');
  await setWorkHours(saoPaulo);
  await setWorkHours(manaus);
}, 60_000);

afterAll(async () => {
  for (const fixture of [saoPaulo, manaus, kiritimati, pagoPago]) {
    await cleanupDedicatedFixture(fixturePrisma, fixture);
  }
  await fixturePrisma.$disconnect();
  await app?.close();
});

describe('[AD-039] GET /clinic — o fuso da clínica', () => {
  it('clínica criada sem dizer o fuso responde America/Sao_Paulo', async () => {
    const response = await api().get('/api/v1/clinic').set(as(saoPaulo));

    expect(response.status).toBe(200);
    expect(response.body.timeZone).toBe('America/Sao_Paulo');
  });

  it('cada clínica responde o seu', async () => {
    expect((await api().get('/api/v1/clinic').set(as(manaus))).body.timeZone).toBe('America/Manaus');
    expect((await api().get('/api/v1/clinic').set(as(kiritimati))).body.timeZone).toBe('Pacific/Kiritimati');
  });

  it('as rotas de edição da clínica não aceitam o fuso: quem pode alterá-lo ainda não foi decidido (ADR-0064)', async () => {
    const patch = await api().patch('/api/v1/clinic').set(as(saoPaulo)).send({ timeZone: 'Asia/Tokyo' });
    const policies = await api().put('/api/v1/clinic/policies').set(as(saoPaulo)).send({ timeZone: 'Asia/Tokyo' });

    expect(patch.status).toBe(400);
    expect(policies.status).toBe(400);
    expect((await api().get('/api/v1/clinic').set(as(saoPaulo))).body.timeZone).toBe('America/Sao_Paulo');
  });
});

describe('[AD-039] agenda — a janela "09:00" vale na hora da clínica, com o processo em qualquer fuso', () => {
  it('São Paulo: os horários livres começam às 09:00 de lá, que é 12:00 UTC', async () => {
    const slots = await slotsOn(saoPaulo, 'America/Sao_Paulo');

    expect(slots).toHaveLength(2);
    expect(slots.map((slot) => new Date(slot).getUTCHours())).toEqual([12, 13]); // São Paulo é UTC-3 o ano inteiro
    expect(slots[0]).toBe(clinicTimeAt(DAYS_AHEAD, 9, 0, 'America/Sao_Paulo').toISOString());
  });

  it('Manaus, com as mesmas janelas: 09:00 de lá, que é 13:00 UTC', async () => {
    const slots = await slotsOn(manaus, 'America/Manaus');

    expect(slots).toHaveLength(2);
    expect(slots.map((slot) => new Date(slot).getUTCHours())).toEqual([13, 14]); // Manaus é UTC-4 o ano inteiro
  });

  it('São Paulo: marcar às 09:00 de lá é aceito; às 09:00 UTC (06:00 de lá, o que o contêiner oferecia antes) é recusado', async () => {
    const nineInSaoPaulo = clinicTimeAt(DAYS_AHEAD, 9, 0, 'America/Sao_Paulo');
    const nineUtc = new Date(nineInSaoPaulo.getTime() - 3 * 60 * 60 * 1000);

    const refused = await book(saoPaulo, nineUtc);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('SLOT_NOT_AVAILABLE');

    const accepted = await book(saoPaulo, nineInSaoPaulo);
    expect(accepted.status).toBe(201);
    expect(new Date(accepted.body.scheduledAt).getUTCHours()).toBe(12);
  });

  it('o mesmo instante serve a uma clínica e não à outra: 12:00 UTC é 09:00 em São Paulo e 08:00 em Manaus', async () => {
    const instant = clinicTimeAt(DAYS_AHEAD + 1, 9, 0, 'America/Sao_Paulo');

    expect((await book(saoPaulo, instant)).status).toBe(201);
    const inManaus = await book(manaus, instant);
    expect(inManaus.status).toBe(409);
    expect(inManaus.body.error.code).toBe('SLOT_NOT_AVAILABLE');

    expect((await book(manaus, clinicTimeAt(DAYS_AHEAD + 1, 9, 0, 'America/Manaus'))).status).toBe(201);
  });

  it('o último horário da janela termina às 11:00 de lá; às 10:30 já não cabe', async () => {
    expect((await book(saoPaulo, clinicTimeAt(DAYS_AHEAD + 2, 10, 0, 'America/Sao_Paulo'))).status).toBe(201);
    expect((await book(saoPaulo, clinicTimeAt(DAYS_AHEAD + 3, 10, 30, 'America/Sao_Paulo'))).status).toBe(409);
  });
});

describe('[AD-039] cobrança — o dia do vencimento é o da clínica', () => {
  it('São Paulo: a cobrança que vence hoje (no calendário de lá) está em dia; a que venceu ontem, em atraso', async () => {
    const today = civilDateIn(new Date(), 'America/Sao_Paulo');
    await createBilling(saoPaulo, formatCivilDate(today), 110);
    await createBilling(saoPaulo, formatCivilDate(addCivilDays(today, -1)), 120);
    await createBilling(saoPaulo, formatCivilDate(addCivilDays(today, 1)), 130);

    expect(await overdueByAmount(saoPaulo)).toEqual({ 110: false, 120: true, 130: false });
    expect(await overdueCount(saoPaulo)).toBe(1);
  });

  it('a mesma data de vencimento, no mesmo instante: em atraso em Kiritimati (onde esse dia já acabou) e em dia em Pago Pago', async () => {
    // Kiritimati está sempre pelo menos um dia à frente de Pago Pago.
    const yesterdayInKiritimati = formatCivilDate(addCivilDays(civilDateIn(new Date(), 'Pacific/Kiritimati'), -1));
    await createBilling(kiritimati, yesterdayInKiritimati, 210);
    await createBilling(pagoPago, yesterdayInKiritimati, 210);

    expect(await overdueByAmount(kiritimati)).toEqual({ 210: true });
    expect(await overdueByAmount(pagoPago)).toEqual({ 210: false });
  });

  it('Dashboard e Financeiro concordam em cada clínica', async () => {
    for (const fixture of [saoPaulo, kiritimati, pagoPago]) {
      const flagged = Object.values(await overdueByAmount(fixture)).filter(Boolean).length;
      expect(await overdueCount(fixture)).toBe(flagged);
    }
    expect(await overdueCount(kiritimati)).toBe(1);
    expect(await overdueCount(pagoPago)).toBe(0);
  });
});
