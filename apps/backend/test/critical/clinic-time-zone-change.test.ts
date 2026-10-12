import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, UserRole } from '@prisma/client';
import { addCivilDays, civilDateIn, formatCivilDate, localDateTime } from '@domain/shared/time-zone';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';
import { clinicTimeAt } from '../support/clinic-time';

/**
 * AD-039 (ADR-0064) — alterar o fuso da clínica, pela rota que o painel usa:
 * `PUT /clinic/time-zone`. App real, Postgres real.
 *
 *   - só o administrador da própria clínica altera; terapeuta e quem não tem
 *     sessão, não;
 *   - só entra o nome exato de uma zona da base IANA;
 *   - a troca de uma clínica não alcança outra, e a clínica nunca vem do corpo;
 *   - a troca e o registro de auditoria (quem, de qual fuso, para qual) são
 *     gravados na mesma transação;
 *   - a troca vale daqui em diante e não reescreve nada: as janelas de
 *     atendimento e o dia do vencimento passam a valer no fuso novo, e as
 *     consultas e cobranças gravadas continuam exatamente como estavam.
 *
 * Os instantes são escritos em UTC ou calculados no fuso dito no teste: o
 * resultado é o mesmo com o processo em qualquer fuso (o CI roda em UTC).
 *
 * Os testes de cada bloco rodam em ordem e deixam a clínica no fuso que o
 * bloco seguinte espera; cada bloco começa conferindo de onde parte.
 */
let app: INestApplication;
let fixturePrisma: PrismaClient;
let clinic: DedicatedFixture;
let neighbour: DedicatedFixture;
let adminToken: string;
let adminUserId: string;
let therapistToken: string;

const SAO_PAULO = 'America/Sao_Paulo';
const MANAUS = 'America/Manaus';
const DAYS_AHEAD = 420;
const WORK_HOURS = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startTime: '09:00', endTime: '11:00', sessionDurationMinutes: 60 }));

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

const api = () => request(app.getHttpServer());
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

const changeTimeZone = (token: string, body: unknown) =>
  api()
    .put('/api/v1/clinic/time-zone')
    .set(as(token))
    .send(body as object);

/** O fuso como a API o informa. */
async function timeZoneOf(token: string): Promise<string> {
  const response = await api().get('/api/v1/clinic').set(as(token));
  expect(response.status).toBe(200);
  return response.body.timeZone;
}

/** O fuso como está gravado, lido direto do banco. */
async function storedTimeZone(fixture: DedicatedFixture): Promise<string> {
  return (await fixturePrisma.clinicSettings.findUniqueOrThrow({ where: { tenantId: fixture.tenantId } })).timeZone;
}

interface TimeZoneAudit {
  userId: string | null;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string;
  result: string;
  payload: { action: string; fromTimeZone: string; toTimeZone: string };
}

/** As trocas de fuso registradas na trilha da clínica, lidas direto do banco. */
async function timeZoneAudits(fixture: DedicatedFixture): Promise<TimeZoneAudit[]> {
  const rows = await fixturePrisma.auditLog.findMany({ where: { tenantId: fixture.tenantId, action: 'ClinicaAtualizada' } });
  return (rows as unknown as TimeZoneAudit[]).filter((row) => row.payload?.action === 'fuso_alterado');
}

async function slotsOn(daysAhead: number, timeZone: string): Promise<string[]> {
  const from = clinicTimeAt(daysAhead, 0, 0, timeZone);
  const to = new Date(clinicTimeAt(daysAhead + 1, 0, 0, timeZone).getTime() - 1);
  const response = await api()
    .get(`/api/v1/therapists/${clinic.therapistId}/availability`)
    .query({ from: from.toISOString(), to: to.toISOString() })
    .set(as(adminToken));
  expect(response.status).toBe(200);
  return (response.body.data as Array<{ startsAt: string }>).map((slot) => slot.startsAt);
}

async function book(scheduledAt: Date) {
  const response = await api()
    .post('/api/v1/appointments')
    .set(as(adminToken))
    .send({ patientId: clinic.patientId, therapistId: clinic.therapistId, scheduledAt: scheduledAt.toISOString(), modality: 'presencial' });
  if (response.status === 201) clinic.appointmentIds.push(response.body.id);
  return response;
}

async function overdueOf(billingId: string): Promise<boolean> {
  const response = await api().get('/api/v1/billings').set(as(adminToken));
  expect(response.status).toBe(200);
  return (response.body.data as Array<{ id: string; overdue: boolean }>).find((billing) => billing.id === billingId)!.overdue;
}

async function overdueCount(): Promise<number> {
  const response = await api().get('/api/v1/dashboard/summary').set(as(adminToken));
  expect(response.status).toBe(200);
  return response.body.overdueBillings;
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  app = await bootstrapTestApp();

  clinic = await createDedicatedFixture(fixturePrisma, 'FUSOALT', { withActiveSubscription: true, withClinicSettings: true });
  adminToken = await createDedicatedUserAndLogin(fixturePrisma, app, clinic, 'FUSOALT', UserRole.admin);
  adminUserId = clinic.userId!;
  therapistToken = await createDedicatedUserAndLogin(fixturePrisma, app, clinic, 'FUSOALT', UserRole.therapist);

  neighbour = await createDedicatedFixture(fixturePrisma, 'FUSOVIZ', { withActiveSubscription: true, withClinicSettings: true });
  await createDedicatedUserAndLogin(fixturePrisma, app, neighbour, 'FUSOVIZ', UserRole.admin);
}, 60_000);

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, clinic);
  await cleanupDedicatedFixture(fixturePrisma, neighbour);
  await fixturePrisma.$disconnect();
  await app?.close();
});

describe('[AD-039] PUT /clinic/time-zone — quem pode alterar o fuso', () => {
  it('a clínica nasce em America/Sao_Paulo', async () => {
    expect(await timeZoneOf(adminToken)).toBe(SAO_PAULO);
    expect(await storedTimeZone(clinic)).toBe(SAO_PAULO);
  });

  it('sem sessão: 401, e nada muda', async () => {
    const response = await api().put('/api/v1/clinic/time-zone').send({ timeZone: MANAUS });

    expect(response.status).toBe(401);
    expect(await storedTimeZone(clinic)).toBe(SAO_PAULO);
  });

  it('terapeuta: 403, nada muda e nada é registrado', async () => {
    const response = await changeTimeZone(therapistToken, { timeZone: MANAUS });

    expect(response.status).toBe(403);
    expect(await storedTimeZone(clinic)).toBe(SAO_PAULO);
    expect(await timeZoneAudits(clinic)).toHaveLength(0);
  });

  it('terapeuta continua vendo o fuso da clínica (leitura)', async () => {
    expect(await timeZoneOf(therapistToken)).toBe(SAO_PAULO);
  });

  it('administrador: 200, o fuso novo vem na resposta, fica gravado e é o que a clínica inteira passa a ler', async () => {
    const response = await changeTimeZone(adminToken, { timeZone: MANAUS });

    expect(response.status).toBe(200);
    expect(response.body.timeZone).toBe(MANAUS);
    expect(await storedTimeZone(clinic)).toBe(MANAUS);
    expect(await timeZoneOf(adminToken)).toBe(MANAUS);
    expect(await timeZoneOf(therapistToken)).toBe(MANAUS);
  });

  it('a troca só altera o fuso: nome, políticas e dados de recebimento ficam como estavam', async () => {
    const before = (await api().get('/api/v1/clinic').set(as(adminToken))).body;

    const response = await changeTimeZone(adminToken, { timeZone: SAO_PAULO });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ...before, timeZone: SAO_PAULO });
  });

  it('as outras edições da clínica não mexem no fuso', async () => {
    expect((await changeTimeZone(adminToken, { timeZone: MANAUS })).status).toBe(200);

    expect((await api().patch('/api/v1/clinic').set(as(adminToken)).send({ name: 'Clínica do Fuso' })).status).toBe(200);
    expect((await api().put('/api/v1/clinic/policies').set(as(adminToken)).send({ cancellationHoursLimit: 12 })).status).toBe(200);
    expect((await api().put('/api/v1/clinic/payment-info').set(as(adminToken)).send({ payeeName: 'Clínica do Fuso Ltda' })).status).toBe(200);

    expect(await storedTimeZone(clinic)).toBe(MANAUS);
  });
});

describe('[AD-039] PUT /clinic/time-zone — só o nome exato de uma zona IANA', () => {
  const INVALID: Array<[string, unknown]> = [
    ['nome que não existe', { timeZone: 'Brasilia' }],
    ['zona inventada', { timeZone: 'Marte/Olimpo' }],
    ['maiúsculas trocadas', { timeZone: 'america/sao_paulo' }],
    ['apelido UTC', { timeZone: 'UTC' }],
    ['apelido GMT', { timeZone: 'GMT' }],
    ['deslocamento fixo', { timeZone: '-03:00' }],
    ['espaço em volta', { timeZone: ' America/Sao_Paulo ' }],
    ['texto vazio', { timeZone: '' }],
    ['número', { timeZone: 3 }],
    ['nulo', { timeZone: null }],
    ['lista', { timeZone: [SAO_PAULO] }],
    ['objeto', { timeZone: { name: SAO_PAULO } }],
    ['corpo sem o campo', {}],
    ['campo a mais', { timeZone: SAO_PAULO, name: 'Outro Nome' }],
  ];

  it.each(INVALID)('%s: 400, e o fuso gravado não muda', async (_label, body) => {
    const before = await storedTimeZone(clinic);
    const audits = (await timeZoneAudits(clinic)).length;

    const response = await changeTimeZone(adminToken, body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(await storedTimeZone(clinic)).toBe(before);
    expect(await timeZoneAudits(clinic)).toHaveLength(audits);
  });

  it('aceita zonas de fora do Brasil, e de volta', async () => {
    for (const zone of ['Europe/Lisbon', 'Asia/Tokyo', 'Pacific/Kiritimati', SAO_PAULO]) {
      const response = await changeTimeZone(adminToken, { timeZone: zone });
      expect(response.status, zone).toBe(200);
      expect(await storedTimeZone(clinic)).toBe(zone);
    }
  });
});

describe('[AD-039] PUT /clinic/time-zone — isolamento entre clínicas', () => {
  it('trocar o fuso de uma clínica não muda o de outra', async () => {
    expect(await storedTimeZone(neighbour)).toBe(SAO_PAULO);

    expect((await changeTimeZone(adminToken, { timeZone: 'Asia/Tokyo' })).status).toBe(200);

    expect(await storedTimeZone(clinic)).toBe('Asia/Tokyo');
    expect(await storedTimeZone(neighbour)).toBe(SAO_PAULO);
    expect(await timeZoneOf(neighbour.token!)).toBe(SAO_PAULO);
    expect(await timeZoneAudits(neighbour)).toHaveLength(0);
  });

  it('a clínica nunca vem do corpo: apontar para outra clínica é recusado, e a outra não muda', async () => {
    const response = await changeTimeZone(adminToken, { timeZone: MANAUS, tenantId: neighbour.tenantId });

    expect(response.status).toBe(400);
    expect(await storedTimeZone(neighbour)).toBe(SAO_PAULO);
    expect(await storedTimeZone(clinic)).toBe('Asia/Tokyo');
  });

  it('cada administrador altera a própria clínica, e só ela', async () => {
    expect((await changeTimeZone(neighbour.token!, { timeZone: 'America/Noronha' })).status).toBe(200);

    expect(await storedTimeZone(neighbour)).toBe('America/Noronha');
    expect(await storedTimeZone(clinic)).toBe('Asia/Tokyo');

    // A trilha de cada clínica só tem as trocas dela.
    expect((await timeZoneAudits(neighbour)).map((audit) => audit.payload.toTimeZone)).toEqual(['America/Noronha']);
    expect((await timeZoneAudits(clinic)).every((audit) => audit.entityId === clinic.tenantId)).toBe(true);

    expect((await changeTimeZone(neighbour.token!, { timeZone: SAO_PAULO })).status).toBe(200);
    expect((await changeTimeZone(adminToken, { timeZone: SAO_PAULO })).status).toBe(200);
  });
});

describe('[AD-039] PUT /clinic/time-zone — auditoria', () => {
  it('registra quem trocou, de qual fuso e para qual — e o administrador lê o registro em GET /audit-log', async () => {
    const before = (await timeZoneAudits(clinic)).length;

    expect((await changeTimeZone(adminToken, { timeZone: MANAUS })).status).toBe(200);

    const audits = await timeZoneAudits(clinic);
    expect(audits).toHaveLength(before + 1);
    const stored = audits.find((audit) => audit.payload.fromTimeZone === SAO_PAULO && audit.payload.toTimeZone === MANAUS && audit.userId === adminUserId);
    expect(stored).toMatchObject({ actorType: 'user', action: 'ClinicaAtualizada', entityType: 'ClinicUpdated', entityId: clinic.tenantId, result: 'success' });

    const read = await api().get('/api/v1/audit-log').query({ limit: 200 }).set(as(adminToken));
    expect(read.status).toBe(200);
    const entries = (read.body.data as TimeZoneAudit[]).filter((entry) => entry.payload?.action === 'fuso_alterado');
    expect(entries).toHaveLength(before + 1);
    expect(entries.every((entry) => entry.userId === adminUserId && entry.entityId === clinic.tenantId)).toBe(true);
  });

  it('a troca e o registro são gravados pela mesma transação', async () => {
    // `xmin` é a transação que gravou a versão atual de cada linha.
    const [settings] = await fixturePrisma.$queryRaw<Array<{ xid: string }>>`
      SELECT xmin::text AS xid FROM clinic_settings WHERE tenant_id = ${clinic.tenantId}
    `;
    const audits = await fixturePrisma.$queryRaw<Array<{ xid: string }>>`
      SELECT xmin::text AS xid FROM audit_log
      WHERE tenant_id = ${clinic.tenantId} AND payload->>'action' = 'fuso_alterado' AND payload->>'toTimeZone' = ${MANAUS}
      ORDER BY created_at DESC LIMIT 1
    `;

    expect(audits).toHaveLength(1);
    expect(audits[0].xid).toBe(settings.xid);
  });

  it('pedir o fuso que já está em vigor: 200, sem gravar e sem registrar de novo', async () => {
    const audits = (await timeZoneAudits(clinic)).length;
    const [before] = await fixturePrisma.$queryRaw<Array<{ xid: string }>>`SELECT xmin::text AS xid FROM clinic_settings WHERE tenant_id = ${clinic.tenantId}`;

    const response = await changeTimeZone(adminToken, { timeZone: MANAUS });

    expect(response.status).toBe(200);
    expect(response.body.timeZone).toBe(MANAUS);
    expect(await timeZoneAudits(clinic)).toHaveLength(audits);
    const [after] = await fixturePrisma.$queryRaw<Array<{ xid: string }>>`SELECT xmin::text AS xid FROM clinic_settings WHERE tenant_id = ${clinic.tenantId}`;
    expect(after.xid).toBe(before.xid);
  });

  it('trocas simultâneas da mesma clínica acontecem uma depois da outra: a trilha é uma corrente sem buraco', async () => {
    expect((await changeTimeZone(adminToken, { timeZone: SAO_PAULO })).status).toBe(200);
    const known = new Set((await timeZoneAudits(clinic)).map((audit) => JSON.stringify(audit)));
    const zones = ['America/Manaus', 'America/Cuiaba', 'America/Belem', 'America/Recife', 'America/Noronha', 'America/Rio_Branco', 'America/Boa_Vista', 'America/Bahia'];

    const responses = await Promise.all(zones.map((zone) => changeTimeZone(adminToken, { timeZone: zone })));

    expect(responses.map((response) => response.status)).toEqual(zones.map(() => 200));
    const fresh = (await timeZoneAudits(clinic)).filter((audit) => !known.has(JSON.stringify(audit)));
    expect(fresh).toHaveLength(zones.length);
    expect(fresh.map((audit) => audit.payload.toTimeZone).sort()).toEqual([...zones].sort());

    // Cada troca parte do fuso que a anterior gravou: começando em São Paulo, dá para percorrer todas.
    const byOrigin = new Map(fresh.map((audit) => [audit.payload.fromTimeZone, audit.payload.toTimeZone]));
    expect(byOrigin.size).toBe(zones.length);
    let current = SAO_PAULO;
    for (let step = 0; step < zones.length; step += 1) {
      const next = byOrigin.get(current);
      expect(next, `nenhuma troca registrada a partir de ${current}`).toBeDefined();
      current = next!;
    }
    // E o fuso gravado é o da última troca da corrente.
    expect(await storedTimeZone(clinic)).toBe(current);

    expect((await changeTimeZone(adminToken, { timeZone: SAO_PAULO })).status).toBe(200);
  });
});

describe('[AD-039] trocar o fuso — a agenda passa a valer no fuso novo, e o que já está marcado não é reescrito', () => {
  let bookedId: string;
  const nineInSaoPaulo = () => clinicTimeAt(DAYS_AHEAD, 9, 0, SAO_PAULO);

  it('em São Paulo, a janela "09:00–11:00" oferece 09:00 e 10:00 de lá (12:00 e 13:00 UTC)', async () => {
    expect(await storedTimeZone(clinic)).toBe(SAO_PAULO);
    const saved = await api().put(`/api/v1/therapists/${clinic.therapistId}/availability`).set(as(adminToken)).send({ windows: WORK_HOURS });
    expect(saved.status).toBe(200);
    clinic.calendarId = (await fixturePrisma.availabilityCalendar.findUniqueOrThrow({ where: { therapistId: clinic.therapistId } })).id;

    const slots = await slotsOn(DAYS_AHEAD, SAO_PAULO);

    expect(slots.map((slot) => new Date(slot).getUTCHours())).toEqual([12, 13]);
    expect(slots[0]).toBe(nineInSaoPaulo().toISOString());
  });

  it('uma consulta é marcada às 09:00 de São Paulo', async () => {
    const response = await book(nineInSaoPaulo());

    expect(response.status).toBe(201);
    bookedId = response.body.id;
  });

  it('depois da troca para Manaus, as mesmas janelas oferecem 09:00 e 10:00 de Manaus (13:00 e 14:00 UTC)', async () => {
    expect((await changeTimeZone(adminToken, { timeZone: MANAUS })).status).toBe(200);

    // As janelas gravadas são as mesmas: horas de parede, sem fuso.
    const calendar = await api().get(`/api/v1/therapists/${clinic.therapistId}/availability/calendar`).set(as(adminToken));
    expect(calendar.status).toBe(200);
    expect(calendar.body.windows).toHaveLength(WORK_HOURS.length);
    expect(calendar.body.windows[0]).toMatchObject({ startTime: '09:00', endTime: '11:00' });

    const slots = await slotsOn(DAYS_AHEAD + 1, MANAUS);
    expect(slots.map((slot) => new Date(slot).getUTCHours())).toEqual([13, 14]);
  });

  it('a consulta já marcada continua no mesmo instante — não é reescrita, e passa a ser lida como 08:00 de Manaus', async () => {
    const stored = await fixturePrisma.appointment.findUniqueOrThrow({ where: { id: bookedId } });

    expect(stored.scheduledAt.toISOString()).toBe(nineInSaoPaulo().toISOString());
    expect(localDateTime(stored.scheduledAt, SAO_PAULO)).toMatchObject({ hour: 9, minute: 0 });
    expect(localDateTime(stored.scheduledAt, MANAUS)).toMatchObject({ hour: 8, minute: 0 });

    const hour = 60 * 60 * 1000;
    const listed = await api()
      .get('/api/v1/appointments')
      .query({ from: new Date(stored.scheduledAt.getTime() - hour).toISOString(), to: new Date(stored.scheduledAt.getTime() + hour).toISOString() })
      .set(as(adminToken));
    expect(listed.status).toBe(200);
    const mine = (listed.body.data as Array<{ id: string; scheduledAt: string }>).find((appointment) => appointment.id === bookedId);
    expect(new Date(mine!.scheduledAt).toISOString()).toBe(nineInSaoPaulo().toISOString());
  });

  it('marcar daqui em diante segue o fuso novo: 09:00 de São Paulo é recusado, 09:00 de Manaus é aceito', async () => {
    const refused = await book(clinicTimeAt(DAYS_AHEAD + 2, 9, 0, SAO_PAULO));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('SLOT_NOT_AVAILABLE');

    expect((await book(clinicTimeAt(DAYS_AHEAD + 2, 9, 0, MANAUS))).status).toBe(201);
  });

  it('de volta a São Paulo, a agenda volta a oferecer 09:00 de lá', async () => {
    expect((await changeTimeZone(adminToken, { timeZone: SAO_PAULO })).status).toBe(200);

    const slots = await slotsOn(DAYS_AHEAD + 3, SAO_PAULO);
    expect(slots.map((slot) => new Date(slot).getUTCHours())).toEqual([12, 13]);
  });
});

describe('[AD-039] trocar o fuso — o dia do vencimento passa a ser o do fuso novo, e a cobrança não é alterada', () => {
  // Kiritimati (UTC+14) está sempre pelo menos um dia à frente de Pago Pago (UTC-11):
  // a cobrança que vence "hoje em Pago Pago" já venceu em Kiritimati, a qualquer hora em que o teste rode.
  const PAGO_PAGO = 'Pacific/Pago_Pago';
  const KIRITIMATI = 'Pacific/Kiritimati';
  let billingId: string;
  let before: { amount: string; status: string; dueDate: string; updatedAt: string };

  const snapshot = async () => {
    const row = await fixturePrisma.billing.findUniqueOrThrow({ where: { id: billingId } });
    return { amount: row.amount.toString(), status: row.status, dueDate: row.dueDate.toISOString(), updatedAt: row.updatedAt.toISOString() };
  };

  it('em Pago Pago, a cobrança que vence hoje está em dia', async () => {
    expect((await changeTimeZone(adminToken, { timeZone: PAGO_PAGO })).status).toBe(200);
    const dueToday = formatCivilDate(civilDateIn(new Date(), PAGO_PAGO));
    const billing = await fixturePrisma.billing.create({
      data: { tenantId: clinic.tenantId, patientId: clinic.patientId, amount: 310, dueDate: new Date(dueToday), status: 'enviada' },
    });
    clinic.billingIds.push(billing.id);
    billingId = billing.id;
    before = await snapshot();

    expect(await overdueOf(billingId)).toBe(false);
    expect(await overdueCount()).toBe(0);
  });

  it('trocando para Kiritimati, onde esse dia já acabou, a mesma cobrança passa a constar em atraso — no Financeiro e no Dashboard', async () => {
    expect((await changeTimeZone(adminToken, { timeZone: KIRITIMATI })).status).toBe(200);

    expect(await overdueOf(billingId)).toBe(true);
    expect(await overdueCount()).toBe(1);
  });

  it('nada da cobrança foi regravado: valor, estado, vencimento e data de alteração são os mesmos', async () => {
    expect(await snapshot()).toEqual(before);
  });

  it('a fronteira é a meia-noite do fuso em vigor: vence hoje, em dia; venceu ontem, em atraso', async () => {
    const today = civilDateIn(new Date(), KIRITIMATI);
    const dueToday = await fixturePrisma.billing.create({
      data: { tenantId: clinic.tenantId, patientId: clinic.patientId, amount: 320, dueDate: new Date(formatCivilDate(today)), status: 'enviada' },
    });
    const dueYesterday = await fixturePrisma.billing.create({
      data: { tenantId: clinic.tenantId, patientId: clinic.patientId, amount: 330, dueDate: new Date(formatCivilDate(addCivilDays(today, -1))), status: 'enviada' },
    });
    clinic.billingIds.push(dueToday.id, dueYesterday.id);

    expect(await overdueOf(dueToday.id)).toBe(false);
    expect(await overdueOf(dueYesterday.id)).toBe(true);
  });

  it('de volta a Pago Pago, a primeira cobrança volta a estar em dia — e continua sem ter sido regravada', async () => {
    expect((await changeTimeZone(adminToken, { timeZone: PAGO_PAGO })).status).toBe(200);

    expect(await overdueOf(billingId)).toBe(false);
    expect(await snapshot()).toEqual(before);
  });
});
