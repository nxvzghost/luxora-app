import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';
import { clinicTimeAt } from '../support/clinic-time';
import { attendedSession } from './support/attended-session';

/**
 * [CRÍTICO — K2-a] Proteção da cobrança no banco e na aplicação
 * (ADR-0069, seções 2.9, 3.6, 3.7 e 9.4; exceção restrita à ADR-0060).
 *
 * O banco precisa recusar cobrança e vínculo inválidos venham de onde vierem,
 * inclusive de uma versão anterior da aplicação num rollback. Para provar
 * isso sem subir a versão antiga, os testes de "versão antiga" executam, com
 * o papel da aplicação e sob RLS, exatamente o SQL que o Prisma do `fd0874f`
 * emite: as colunas que ele conhece e o `INSERT … ON CONFLICT ("id") DO
 * UPDATE` de BillingRepository.save() (comando conferido com o próprio
 * Prisma do projeto em 21/10/2026). O ensaio com a imagem antiga de verdade
 * está em infra/tests/k2-compat-rehearsal.sh.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let appDb: PrismaClient;
let clinicA: DedicatedFixture;
let clinicB: DedicatedFixture;
let tokenA: string;
let otherPatientId: string;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

const api = () => request(app.getHttpServer());
const auth = () => ({ Authorization: `Bearer ${tokenA}` });
const FIRST = clinicTimeAt(75, 8);
let slot = 0;

/**
 * Uma sessão a faturar, criada pela API. K2-b: consulta que já aconteceu,
 * com a realização registrada (confirmar não cria mais sessão).
 */
async function billableSession(patientId: string): Promise<string> {
  slot += 1;
  const scheduledAt = new Date(clinicTimeAt(-75, 8).getTime() + slot * 2 * 60 * 60 * 1000).toISOString();
  const { appointmentId, sessionId } = await attendedSession(app, tokenA, { patientId, therapistId: clinicA.therapistId, scheduledAt });
  clinicA.appointmentIds.push(appointmentId);
  clinicA.sessionIds.push(sessionId);
  return sessionId;
}

async function createBilling(sessionIds: string[], patientId = clinicA.patientId) {
  return api().post('/api/v1/billings').set(auth()).send({ patientId, amount: 400, dueDate: '2026-12-10', sessionIds });
}

/** Executa SQL com o papel da aplicação, sob a RLS da clínica — como a aplicação faz. */
async function asApp(tenantId: string, sql: string, ...params: unknown[]): Promise<number> {
  return appDb.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
    return tx.$executeRawUnsafe(sql, ...params);
  });
}

/** SQLSTATE do erro do PostgreSQL devolvido pelo Prisma numa consulta crua. */
async function sqlStateOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (err) {
    const message = String((err as Error).message);
    return message.match(/Code: `(\w+)`/)?.[1] ?? (err as { meta?: { code?: string } }).meta?.code ?? message;
  }
  return 'sem erro';
}

/** O INSERT … ON CONFLICT que BillingRepository.save() do `fd0874f` emite, sem as colunas do K2-a. */
const OLD_VERSION_BILLING_UPSERT = `
  INSERT INTO "public"."billing" ("id","tenant_id","patient_id","amount","status","due_date","created_at","updated_at")
  VALUES ($1, $2, $3, $4::numeric, CAST($5::text AS "public"."BillingStatus"), $6::timestamp, now(), now())
  ON CONFLICT ("id") DO UPDATE SET "status" = CAST($5::text AS "public"."BillingStatus"), "updated_at" = now()`;

/** O vínculo que linkSessions() do `fd0874f` grava, sem o paciente. */
const OLD_VERSION_LINK = `
  INSERT INTO "public"."billing_session" ("id","tenant_id","billing_id","session_id","created_at")
  VALUES ($1, $2, $3, $4, now())`;

const oldVersionUpsert = (billingId: string, status: string) =>
  asApp(clinicA.tenantId, OLD_VERSION_BILLING_UPSERT, billingId, clinicA.tenantId, clinicA.patientId, '400', status, '2026-12-10');

/**
 * Uma cobrança que já existia antes do K2-a: legada, sem protocolo (só o
 * administrador grava assim). legacy_billing e legacy_link ficam fora do
 * Prisma Client (@ignore), por isso o SQL cru aqui e em legacyFlags().
 */
async function legacyBilling(status: 'enviada' | 'pendente' = 'enviada'): Promise<string> {
  const id = randomUUID();
  await fixturePrisma.$executeRawUnsafe(
    `INSERT INTO "public"."billing" ("id","tenant_id","patient_id","amount","status","due_date","updated_at","legacy_billing","eligibility_protocol")
     VALUES ($1, $2, $3, 400, CAST($4::text AS "public"."BillingStatus"), '2026-12-10', now(), true, NULL)`,
    id,
    clinicA.tenantId,
    clinicA.patientId,
    status,
  );
  clinicA.billingIds.push(id);
  return id;
}

async function legacyFlags(billingId: string): Promise<{ billing: boolean; links: boolean[] }> {
  const [row] = await fixturePrisma.$queryRawUnsafe<Array<{ legacy_billing: boolean }>>(
    `SELECT "legacy_billing" FROM "public"."billing" WHERE "id" = $1`,
    billingId,
  );
  const links = await fixturePrisma.$queryRawUnsafe<Array<{ legacy_link: boolean }>>(
    `SELECT "legacy_link" FROM "public"."billing_session" WHERE "billing_id" = $1`,
    billingId,
  );
  return { billing: row.legacy_billing, links: links.map((link) => link.legacy_link) };
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  appDb = new PrismaClient();
  await appDb.$connect();
  app = await bootstrapTestApp();

  clinicA = await createDedicatedFixture(fixturePrisma, 'K2A-A', { withActiveSubscription: true, withAvailabilityCalendar: true });
  clinicB = await createDedicatedFixture(fixturePrisma, 'K2A-B', { withActiveSubscription: true, withAvailabilityCalendar: true });
  tokenA = await createDedicatedUserAndLogin(fixturePrisma, app, clinicA, 'K2AA');
  const other = await fixturePrisma.patient.create({
    data: { tenantId: clinicA.tenantId, name: `Outro paciente K2-a ${randomUUID()}`, phone: '11988887777' },
  });
  otherPatientId = other.id;
  clinicA.patientIds.push(other.id);
}, 60_000);

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, clinicA);
  await cleanupDedicatedFixture(fixturePrisma, clinicB);
  await appDb.$disconnect();
  await fixturePrisma.$disconnect();
  await app.close();
});

describe('[CRÍTICO — K2-a] versão nova: cobrança com protocolo, conferida e atômica', () => {
  it('cria a cobrança com o protocolo billing-eligibility-v1 e cada vínculo com o paciente', async () => {
    const sessionId = await billableSession(clinicA.patientId);

    const res = await createBilling([sessionId]);

    expect(res.status).toBe(201);
    clinicA.billingIds.push(res.body.id);
    const billing = await fixturePrisma.billing.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(billing.eligibilityProtocol).toBe('billing-eligibility-v1');
    const link = await fixturePrisma.billingSession.findUniqueOrThrow({ where: { sessionId } });
    expect(link.patientId).toBe(clinicA.patientId);
    expect(await legacyFlags(res.body.id)).toEqual({ billing: false, links: [false] });
  });

  it('sessão de outro paciente da mesma clínica: 409 SESSION_OF_ANOTHER_PATIENT e nada é gravado', async () => {
    const mine = await billableSession(clinicA.patientId);
    const theirs = await billableSession(otherPatientId);
    const before = await fixturePrisma.billing.count({ where: { tenantId: clinicA.tenantId } });

    const res = await createBilling([mine, theirs]);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_OF_ANOTHER_PATIENT');
    expect(await fixturePrisma.billing.count({ where: { tenantId: clinicA.tenantId } })).toBe(before);
    expect(await fixturePrisma.billingSession.count({ where: { sessionId: { in: [mine, theirs] } } })).toBe(0);
    expect((await fixturePrisma.session.findUniqueOrThrow({ where: { id: mine } })).state).toBe('Realizada');
  });

  it('sessão de outra clínica: 404 e nada é gravado', async () => {
    const mine = await billableSession(clinicA.patientId);
    const appointmentB = await fixturePrisma.appointment.create({
      data: { tenantId: clinicB.tenantId, patientId: clinicB.patientId, therapistId: clinicB.therapistId, scheduledAt: FIRST, state: 'Confirmada' },
    });
    clinicB.appointmentIds.push(appointmentB.id);
    const sessionB = await fixturePrisma.session.create({
      data: { tenantId: clinicB.tenantId, appointmentId: appointmentB.id, patientId: clinicB.patientId, therapistId: clinicB.therapistId },
    });
    clinicB.sessionIds.push(sessionB.id);
    const before = await fixturePrisma.billing.count({ where: { tenantId: clinicA.tenantId } });

    const res = await createBilling([mine, sessionB.id]);

    expect(res.status).toBe(404);
    expect(await fixturePrisma.billing.count({ where: { tenantId: clinicA.tenantId } })).toBe(before);
    expect(await fixturePrisma.billingSession.count({ where: { sessionId: { in: [mine, sessionB.id] } } })).toBe(0);
  });

  it('sessão já faturada no pedido: 409 SESSION_ALREADY_BILLED (contrato publicado), nada gravado e a outra sessão do pedido continua a faturar', async () => {
    const billed = await billableSession(clinicA.patientId);
    const first = await createBilling([billed]);
    expect(first.status).toBe(201);
    clinicA.billingIds.push(first.body.id);
    const fresh = await billableSession(clinicA.patientId);
    const before = await fixturePrisma.billing.count({ where: { tenantId: clinicA.tenantId } });

    const res = await createBilling([fresh, billed]);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_ALREADY_BILLED');
    expect(await fixturePrisma.billing.count({ where: { tenantId: clinicA.tenantId } })).toBe(before);
    expect((await fixturePrisma.session.findUniqueOrThrow({ where: { id: fresh } })).state).toBe('Realizada');
  });

  it('duas cobranças simultâneas da mesma sessão: uma passa, a outra é desfeita inteira — sem cobrança órfã', async () => {
    const sessionId = await billableSession(clinicA.patientId);
    const before = await fixturePrisma.billing.count({ where: { tenantId: clinicA.tenantId } });

    const results = await Promise.all([createBilling([sessionId]), createBilling([sessionId])]);

    const statuses = results.map((res) => res.status).sort();
    expect(statuses[0]).toBe(201);
    expect(statuses[1]).toBe(409);
    for (const res of results) if (res.status === 201) clinicA.billingIds.push(res.body.id);
    expect(await fixturePrisma.billing.count({ where: { tenantId: clinicA.tenantId } })).toBe(before + 1);
    expect(await fixturePrisma.billingSession.count({ where: { sessionId } })).toBe(1);
    const orphans = await fixturePrisma.billing.count({
      where: { tenantId: clinicA.tenantId, billingSessions: { none: {} }, eligibilityProtocol: 'billing-eligibility-v1' },
    });
    expect(orphans).toBe(0);
  });
});

describe('[CRÍTICO — K2-a] versão antiga (sem a capacidade) contra o banco migrado', () => {
  it('não consegue criar uma cobrança nova: a chave estrangeira do protocolo recusa e nada é gravado', async () => {
    const id = randomUUID();

    expect(await sqlStateOf(oldVersionUpsert(id, 'criada'))).toBe('23503');
    expect(await fixturePrisma.billing.count({ where: { id } })).toBe(0);
  });

  it('continua atualizando o status de uma cobrança nova: envio, régua e quitação', async () => {
    const sessionId = await billableSession(clinicA.patientId);
    const created = await createBilling([sessionId]);
    expect(created.status).toBe(201);
    clinicA.billingIds.push(created.body.id);

    for (const status of ['enviada', 'pendente', 'atrasada', 'escalada', 'quitada']) {
      expect(await oldVersionUpsert(created.body.id, status)).toBe(1);
    }
    const billing = await fixturePrisma.billing.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(billing.status).toBe('quitada');
    expect(billing.eligibilityProtocol).toBe('billing-eligibility-v1');
  });

  it('continua atualizando o status de uma cobrança legada (anterior ao K2-a)', async () => {
    const id = await legacyBilling('enviada');

    for (const status of ['pendente', 'atrasada', 'negociada', 'quitada']) {
      expect(await oldVersionUpsert(id, status)).toBe(1);
    }
    const billing = await fixturePrisma.billing.findUniqueOrThrow({ where: { id } });
    expect(billing.status).toBe('quitada');
    expect((await legacyFlags(id)).billing).toBe(true);
    expect(billing.eligibilityProtocol).toBeNull();
  });

  it('pagamento como a versão antiga faz (pagamento, depois a cobrança): os dois gravam, sem pagamento confirmado com cobrança em aberto', async () => {
    const id = await legacyBilling('enviada');
    const paymentId = randomUUID();

    expect(
      await asApp(
        clinicA.tenantId,
        `INSERT INTO "public"."payment" ("id","tenant_id","billing_id","amount","method","status","idempotency_key","created_at","updated_at")
         VALUES ($1, $2, $3, 400, 'pix', CAST('confirmado' AS "public"."PaymentStatus"), $4, now(), now())`,
        paymentId,
        clinicA.tenantId,
        id,
        `k2a-${paymentId}`,
      ),
    ).toBe(1);
    clinicA.paymentIds.push(paymentId);
    expect(await oldVersionUpsert(id, 'quitada')).toBe(1);

    expect((await fixturePrisma.billing.findUniqueOrThrow({ where: { id } })).status).toBe('quitada');
    expect((await fixturePrisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('confirmado');
  });

  it('não consegue criar um vínculo: o vínculo novo exige o paciente', async () => {
    const id = await legacyBilling('enviada');
    const sessionId = await billableSession(clinicA.patientId);

    expect(await sqlStateOf(asApp(clinicA.tenantId, OLD_VERSION_LINK, randomUUID(), clinicA.tenantId, id, sessionId))).toBe('23514');
    expect(await fixturePrisma.billingSession.count({ where: { sessionId } })).toBe(0);
  });
});

describe('[CRÍTICO — K2-a] o banco confere paciente, clínica e privilégios, para qualquer versão', () => {
  it('vínculo com sessão de outro paciente: recusado pela chave composta', async () => {
    const sessionId = await billableSession(clinicA.patientId);
    const created = await createBilling([sessionId]);
    expect(created.status).toBe(201);
    clinicA.billingIds.push(created.body.id);
    const theirs = await billableSession(otherPatientId);

    const insert = `INSERT INTO "public"."billing_session" ("id","tenant_id","billing_id","session_id","patient_id") VALUES ($1, $2, $3, $4, $5)`;
    expect(await sqlStateOf(asApp(clinicA.tenantId, insert, randomUUID(), clinicA.tenantId, created.body.id, theirs, clinicA.patientId))).toBe('23503');
    expect(await sqlStateOf(asApp(clinicA.tenantId, insert, randomUUID(), clinicA.tenantId, created.body.id, theirs, otherPatientId))).toBe('23503');
    expect(await fixturePrisma.billingSession.count({ where: { sessionId: theirs } })).toBe(0);
  });

  it('vínculo com sessão de outra clínica: recusado pela chave composta (a checagem de chave estrangeira ignora a RLS)', async () => {
    const sessionId = await billableSession(clinicA.patientId);
    const created = await createBilling([sessionId]);
    expect(created.status).toBe(201);
    clinicA.billingIds.push(created.body.id);
    const appointmentB = await fixturePrisma.appointment.create({
      data: { tenantId: clinicB.tenantId, patientId: clinicB.patientId, therapistId: clinicB.therapistId, scheduledAt: new Date(FIRST.getTime() + 3600_000), state: 'Confirmada' },
    });
    clinicB.appointmentIds.push(appointmentB.id);
    const sessionB = await fixturePrisma.session.create({
      data: { tenantId: clinicB.tenantId, appointmentId: appointmentB.id, patientId: clinicB.patientId, therapistId: clinicB.therapistId },
    });
    clinicB.sessionIds.push(sessionB.id);

    const insert = `INSERT INTO "public"."billing_session" ("id","tenant_id","billing_id","session_id","patient_id") VALUES ($1, $2, $3, $4, $5)`;
    expect(await sqlStateOf(asApp(clinicA.tenantId, insert, randomUUID(), clinicA.tenantId, created.body.id, sessionB.id, clinicA.patientId))).toBe('23503');
    expect(await fixturePrisma.billingSession.count({ where: { sessionId: sessionB.id } })).toBe(0);
  });

  it('cobrança nova com protocolo nulo: recusada (só as cobranças legadas têm protocolo nulo)', async () => {
    const id = randomUUID();
    const insert = `INSERT INTO "public"."billing" ("id","tenant_id","patient_id","amount","status","due_date","updated_at","eligibility_protocol")
      VALUES ($1, $2, $3, 400, 'criada', '2026-12-10', now(), NULL)`;

    expect(await sqlStateOf(asApp(clinicA.tenantId, insert, id, clinicA.tenantId, clinicA.patientId))).toBe('23514');
    expect(await fixturePrisma.billing.count({ where: { id } })).toBe(0);
  });

  it('a aplicação não marca cobrança como legada, não muda o protocolo e não escreve nas tabelas de protocolo e de exigência', async () => {
    const sessionId = await billableSession(clinicA.patientId);
    const created = await createBilling([sessionId]);
    expect(created.status).toBe(201);
    clinicA.billingIds.push(created.body.id);
    const t = clinicA.tenantId;

    // Uma tentativa por vez: criadas de uma vez, as rejeições chegariam antes do await.
    const attempts = [
      () => asApp(t, `INSERT INTO "public"."billing" ("id","tenant_id","patient_id","amount","status","due_date","updated_at","legacy_billing") VALUES ($1, $2, $3, 400, 'criada', '2026-12-10', now(), true)`, randomUUID(), t, clinicA.patientId),
      () => asApp(t, `UPDATE "public"."billing" SET "legacy_billing" = true WHERE "id" = $1`, created.body.id),
      () => asApp(t, `UPDATE "public"."billing" SET "eligibility_protocol" = NULL WHERE "id" = $1`, created.body.id),
      () => asApp(t, `UPDATE "public"."billing" SET "amount" = 1 WHERE "id" = $1`, created.body.id),
      () => asApp(t, `UPDATE "public"."billing" SET "patient_id" = $2 WHERE "id" = $1`, created.body.id, otherPatientId),
      () => asApp(t, `UPDATE "public"."billing_session" SET "legacy_link" = true WHERE "session_id" = $1`, sessionId),
      () => asApp(t, `UPDATE "public"."billing_session" SET "patient_id" = $2 WHERE "session_id" = $1`, sessionId, otherPatientId),
      () => asApp(t, `UPDATE "public"."billing_session" SET "session_id" = $2 WHERE "session_id" = $1`, sessionId, randomUUID()),
      () => asApp(t, `INSERT INTO "public"."billing_eligibility_protocol" ("name") VALUES ('nenhum')`),
      () => asApp(t, `UPDATE "public"."billing_eligibility_protocol" SET "name" = 'nenhum' WHERE "name" = 'billing-eligibility-v1'`),
      () => asApp(t, `DELETE FROM "public"."billing_eligibility_protocol"`),
      () => asApp(t, `SELECT 1 FROM "public"."deployment_requirement"`),
      () => asApp(t, `DELETE FROM "public"."deployment_requirement"`),
    ];
    for (const attempt of attempts) {
      expect(await sqlStateOf(attempt())).toBe('42501');
    }
    const billing = await fixturePrisma.billing.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(await legacyFlags(created.body.id)).toEqual({ billing: false, links: [false] });
    expect(billing.eligibilityProtocol).toBe('billing-eligibility-v1');
  });

  it('o papel da aplicação grava só as colunas previstas (o UPDATE extra só existe onde ele é o dono das tabelas)', async () => {
    const rows = await fixturePrisma.$queryRawUnsafe<Array<{ grant: string; owner: string }>>(
      `SELECT c.relname || '.' || a.attname || ':' || p.priv AS "grant", pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE']) AS p(priv)
        WHERE c.relnamespace = 'public'::regnamespace
          AND c.relname IN ('billing', 'billing_session', 'billing_eligibility_protocol', 'deployment_requirement')
          AND has_column_privilege('luxora_app', c.oid, a.attnum, p.priv)
        ORDER BY 1`,
    );
    const appOwnsTables = rows.length > 0 && rows.every((row) => row.owner === 'luxora_app');
    const expected = [
      ...['amount', 'created_at', 'due_date', 'eligibility_protocol', 'id', 'patient_id', 'status', 'tenant_id', 'updated_at'].map((c) => `billing.${c}:INSERT`),
      'billing.status:UPDATE',
      'billing.updated_at:UPDATE',
      ...(appOwnsTables ? ['billing_eligibility_protocol.description:UPDATE'] : []),
      ...['billing_id', 'created_at', 'id', 'patient_id', 'session_id', 'tenant_id'].map((c) => `billing_session.${c}:INSERT`),
      // K2-b — a elegibilidade exigida (o Prisma manda o padrão 'elegivel'); nunca legacy_eligibility_link.
      'billing_session.required_eligibility:INSERT',
      ...(appOwnsTables ? ['billing_session.created_at:UPDATE'] : []),
    ].sort();

    expect(rows.map((row) => row.grant).sort()).toEqual(expected);
  });

  it('o banco declara a exigência billing-eligibility-v1 e mantém todas as restrições do K2-a', async () => {
    const requirement = await fixturePrisma.deploymentRequirement.findMany();
    // K2-b acrescentou appointment-outcome-v1 (ver appointment-outcome-k2b.test.ts).
    expect(requirement.map((row) => row.capability).sort()).toEqual(['appointment-outcome-v1', 'billing-eligibility-v1']);
    expect((await fixturePrisma.billingEligibilityProtocol.findMany()).map((row) => row.name)).toEqual(['billing-eligibility-v1']);

    const expected = [
      'billing_eligibility_protocol_fkey',
      'billing_legacy_or_protocol_check',
      'billing_session_billing_patient_fkey',
      'billing_session_session_patient_fkey',
      'billing_session_legacy_or_patient_check',
    ];
    const rows = await fixturePrisma.$queryRawUnsafe<Array<{ conname: string; convalidated: boolean }>>(
      `SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1::text[]) ORDER BY conname`,
      expected,
    );
    expect(rows.map((row) => row.conname).sort()).toEqual([...expected].sort());
    expect(rows.every((row) => row.convalidated)).toBe(true);
  });
});
