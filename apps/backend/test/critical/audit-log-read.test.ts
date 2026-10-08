import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, UserRole } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * [CRÍTICO — Tarefa 06 da auditoria, AD-022] Leitura da trilha de auditoria.
 *
 * `GET /audit-log` não tinha nenhum teste: audit-immutability.test.ts cobre
 * só a recusa de alterar e apagar. Aqui: quem pode ler, o que cada clínica
 * enxerga, o formato, a paginação, entrada inválida e o que NÃO pode
 * aparecer na resposta (senha, hash, token).
 *
 * As entradas são geradas por ações reais feitas pela API, não inseridas à
 * mão — é a trilha que o sistema de fato grava.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let clinicA: DedicatedFixture;
let clinicB: DedicatedFixture;
let adminA: string;
let therapistA: string;
let adminB: string;

const SECRET_PASSWORD = `senha-que-nao-pode-vazar-${randomUUID()}`;
const SECRET_TOKEN = `token-que-nao-pode-vazar-${randomUUID()}`;
const ENTRY_KEYS = ['action', 'actorType', 'entityId', 'entityType', 'id', 'payload', 'result', 'tenantId', 'userId'];

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

const api = () => request(app.getHttpServer());
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Ações reais que deixam rastro: cadastrar pacientes, criar um usuário e conectar o WhatsApp. */
async function leaveTrail(token: string, patients: number, withSecrets: boolean): Promise<void> {
  for (let i = 0; i < patients; i += 1) {
    const res = await api().post('/api/v1/patients').set(as(token)).send({ name: `Paciente Auditoria ${i}`, phone: `+55419${String(i).padStart(8, '0')}` });
    expect(res.status).toBe(201);
  }
  if (withSecrets) {
    const user = await api()
      .post('/api/v1/users')
      .set(as(token))
      .send({ email: `auditoria-${randomUUID()}@auditlog.luxora.dev`, password: SECRET_PASSWORD, role: 'admin' });
    expect(user.status).toBe(201);
    clinicA.userIds.push(user.body.id);
    const whatsapp = await api().post('/api/v1/whatsapp/connect').set(as(token)).send({ phoneNumberId: `audit-${randomUUID()}`, accessToken: SECRET_TOKEN });
    expect(whatsapp.status).toBe(201);
  }
}

async function trackPatients(fixture: DedicatedFixture): Promise<void> {
  const rows = await fixturePrisma.patient.findMany({ where: { tenantId: fixture.tenantId }, select: { id: true } });
  for (const row of rows) if (!fixture.patientIds.includes(row.id)) fixture.patientIds.push(row.id);
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  app = await bootstrapTestApp();

  clinicA = await createDedicatedFixture(fixturePrisma, 'AUDITREAD-A', { withActiveSubscription: true });
  clinicB = await createDedicatedFixture(fixturePrisma, 'AUDITREAD-B', { withActiveSubscription: true });
  adminA = await createDedicatedUserAndLogin(fixturePrisma, app, clinicA, 'AUDITREADA');
  therapistA = await createDedicatedUserAndLogin(fixturePrisma, app, clinicA, 'AUDITREADA', UserRole.therapist);
  adminB = await createDedicatedUserAndLogin(fixturePrisma, app, clinicB, 'AUDITREADB');

  await leaveTrail(adminA, 5, true);
  await leaveTrail(adminB, 2, false);
  await trackPatients(clinicA);
  await trackPatients(clinicB);
}, 60_000);

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, clinicA);
  await cleanupDedicatedFixture(fixturePrisma, clinicB);
  await fixturePrisma.$disconnect();
  await app.close();
});

describe('[CRÍTICO — AD-022] GET /audit-log — quem pode ler', () => {
  it('sem token: 401', async () => {
    expect((await api().get('/api/v1/audit-log')).status).toBe(401);
  });

  it('token inválido: 401', async () => {
    expect((await api().get('/api/v1/audit-log').set(as('token-invalido'))).status).toBe(401);
  });

  it('perfil terapeuta: 403 — a trilha é só do administrador', async () => {
    const res = await api().get('/api/v1/audit-log').set(as(therapistA));

    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
  });

  it('administrador: 200', async () => {
    expect((await api().get('/api/v1/audit-log').set(as(adminA))).status).toBe(200);
  });

  it('clínica sem assinatura ativa: 403 SUBSCRIPTION_INACTIVE', async () => {
    await fixturePrisma.clinicSubscription.update({ where: { id: clinicB.subscriptionId }, data: { status: 'cancelled' } });
    try {
      const res = await api().get('/api/v1/audit-log').set(as(adminB));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SUBSCRIPTION_INACTIVE');
    } finally {
      await fixturePrisma.clinicSubscription.update({ where: { id: clinicB.subscriptionId }, data: { status: 'active' } });
    }
  });
});

describe('[CRÍTICO — AD-022] GET /audit-log — isolamento entre clínicas', () => {
  it('cada clínica só recebe as próprias entradas', async () => {
    const [resA, resB] = await Promise.all([
      api().get('/api/v1/audit-log?limit=200').set(as(adminA)),
      api().get('/api/v1/audit-log?limit=200').set(as(adminB)),
    ]);

    expect(resA.body.data.length).toBeGreaterThan(0);
    expect(resB.body.data.length).toBeGreaterThan(0);
    expect(resA.body.data.every((entry: { tenantId: string }) => entry.tenantId === clinicA.tenantId)).toBe(true);
    expect(resB.body.data.every((entry: { tenantId: string }) => entry.tenantId === clinicB.tenantId)).toBe(true);
  });

  it('o que foi feito em uma clínica não aparece na trilha da outra', async () => {
    const patientsOfA = (await fixturePrisma.patient.findMany({ where: { tenantId: clinicA.tenantId }, select: { id: true } })).map((p) => p.id);
    const resB = await api().get('/api/v1/audit-log?limit=200').set(as(adminB));

    const seenByB = JSON.stringify(resB.body);
    for (const id of patientsOfA) expect(seenByB).not.toContain(id);
    expect(seenByB).not.toContain(clinicA.tenantId);
  });

  it('a resposta bate com o que está gravado para a clínica — nem a mais, nem a menos', async () => {
    const stored = await fixturePrisma.auditLog.count({ where: { tenantId: clinicA.tenantId } });
    const res = await api().get('/api/v1/audit-log?limit=200').set(as(adminA));

    expect(res.body.data).toHaveLength(stored);
  });
});

describe('[CRÍTICO — AD-022] GET /audit-log — formato e paginação', () => {
  it('cada entrada traz exatamente os campos do contrato', async () => {
    const res = await api().get('/api/v1/audit-log?limit=200').set(as(adminA));

    for (const entry of res.body.data) {
      expect(Object.keys(entry).sort()).toEqual(ENTRY_KEYS);
      expect(typeof entry.action).toBe('string');
      expect(typeof entry.entityType).toBe('string');
    }
  });

  it('sem limit, devolve no máximo 50; as mais recentes primeiro', async () => {
    const res = await api().get('/api/v1/audit-log').set(as(adminA));
    const stored = await fixturePrisma.auditLog.findMany({ where: { tenantId: clinicA.tenantId }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true } });

    expect(res.body.data.length).toBeLessThanOrEqual(50);
    expect(res.body.data[0].id).toBe(stored[0].id);
  });

  it('limit e cursor percorrem a trilha inteira, sem repetir nem pular', async () => {
    const all = await api().get('/api/v1/audit-log?limit=200').set(as(adminA));
    const expectedIds: string[] = all.body.data.map((entry: { id: string }) => entry.id);
    expect(expectedIds.length).toBeGreaterThanOrEqual(5);

    const collected: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const res = await api()
        .get(`/api/v1/audit-log?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
        .set(as(adminA));
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeLessThanOrEqual(2);
      collected.push(...res.body.data.map((entry: { id: string }) => entry.id));
      if (res.body.data.length < 2) break;
      cursor = res.body.data[res.body.data.length - 1].id;
    }

    expect(new Set(collected).size).toBe(collected.length);
    expect(collected).toEqual(expectedIds);
  });

  it('cursor de uma entrada de outra clínica não abre a trilha dela', async () => {
    const foreign = await fixturePrisma.auditLog.findFirstOrThrow({ where: { tenantId: clinicB.tenantId }, select: { id: true } });

    const res = await api().get(`/api/v1/audit-log?limit=200&cursor=${foreign.id}`).set(as(adminA));

    expect(res.status).toBe(200);
    expect(res.body.data.every((entry: { tenantId: string }) => entry.tenantId === clinicA.tenantId)).toBe(true);
  });

  it('ler a trilha não acrescenta nada a ela', async () => {
    const before = await fixturePrisma.auditLog.count({ where: { tenantId: clinicA.tenantId } });

    await api().get('/api/v1/audit-log').set(as(adminA));
    await api().get('/api/v1/audit-log?limit=3').set(as(adminA));

    expect(await fixturePrisma.auditLog.count({ where: { tenantId: clinicA.tenantId } })).toBe(before);
  });
});

describe('[CRÍTICO — AD-022] GET /audit-log — entrada inválida', () => {
  it.each(['abc', '0', '-5', '2.5'])('limit=%s: 400, não erro interno', async (limit) => {
    const res = await api().get(`/api/v1/audit-log?limit=${limit}`).set(as(adminA));

    expect(res.status).toBe(400);
  });

  it('cursor que não existe: lista vazia, não erro interno', async () => {
    const res = await api().get(`/api/v1/audit-log?cursor=${randomUUID()}`).set(as(adminA));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('[CRÍTICO — AD-022] GET /audit-log — o que não pode aparecer', () => {
  it('nem a senha de um usuário criado, nem o token do WhatsApp, nem hash de senha', async () => {
    const res = await api().get('/api/v1/audit-log?limit=200').set(as(adminA));
    const body = JSON.stringify(res.body);

    expect(body).not.toContain(SECRET_PASSWORD);
    expect(body).not.toContain(SECRET_TOKEN);
    expect(body).not.toMatch(/\$2[aby]\$\d{2}\$/); // formato de hash bcrypt
    expect(body.toLowerCase()).not.toContain('passwordhash');
    expect(body.toLowerCase()).not.toContain('accesstoken');
  });

  it('a mensagem de erro de quem não pode ler não revela nada da trilha', async () => {
    const res = await api().get('/api/v1/audit-log').set(as(therapistA));

    expect(JSON.stringify(res.body)).not.toContain(clinicA.tenantId);
    expect(Object.keys(res.body)).toEqual(['error']);
  });
});
