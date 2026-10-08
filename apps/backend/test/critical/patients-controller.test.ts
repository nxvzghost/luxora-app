import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * [CRÍTICO — Tarefa 06 da auditoria, AD-032] PatientsController.
 *
 * Até aqui só o RBAC das rotas que alteram tinha teste
 * (rbac-mutating-routes.test.ts). Este arquivo cobre o resto do contrato:
 * acesso sem sessão, isolamento entre clínicas em leitura e em escrita,
 * validação da entrada, recurso inexistente, paginação e as regras de
 * estado do paciente. Papéis não são repetidos aqui.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let clinicA: DedicatedFixture;
let clinicB: DedicatedFixture;
let tokenA: string;
let tokenB: string;
let patientOfB: string;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

const api = () => request(app.getHttpServer());
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const VALID = { name: 'Maria de Souza', phone: '+5541900001111' };

/** Cadastra pela API e registra o id para a limpeza. */
async function createPatient(token: string, fixture: DedicatedFixture, body: Record<string, unknown> = VALID) {
  const res = await api().post('/api/v1/patients').set(as(token)).send(body);
  if (res.body?.id) fixture.patientIds.push(res.body.id);
  return res;
}

const stored = (id: string) => fixturePrisma.patient.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  app = await bootstrapTestApp();

  clinicA = await createDedicatedFixture(fixturePrisma, 'PATCTRL-A', { withActiveSubscription: true });
  clinicB = await createDedicatedFixture(fixturePrisma, 'PATCTRL-B', { withActiveSubscription: true });
  tokenA = await createDedicatedUserAndLogin(fixturePrisma, app, clinicA, 'PATCTRLA');
  tokenB = await createDedicatedUserAndLogin(fixturePrisma, app, clinicB, 'PATCTRLB');
  patientOfB = clinicB.patientId;
}, 60_000);

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, clinicA);
  await cleanupDedicatedFixture(fixturePrisma, clinicB);
  await fixturePrisma.$disconnect();
  await app.close();
});

describe('[CRÍTICO — AD-032] Pacientes — sem sessão', () => {
  it.each([
    ['GET', '/api/v1/patients'],
    ['POST', '/api/v1/patients'],
    ['GET', `/api/v1/patients/${randomUUID()}`],
    ['PATCH', `/api/v1/patients/${randomUUID()}`],
    ['POST', `/api/v1/patients/${randomUUID()}/deactivate`],
    ['POST', `/api/v1/patients/${randomUUID()}/reactivate`],
    ['POST', `/api/v1/patients/${randomUUID()}/discharge`],
  ])('%s %s sem token: 401', async (method, path) => {
    const res = await (api() as unknown as Record<string, (path: string) => request.Test>)[method.toLowerCase()](path).send({});

    expect(res.status).toBe(401);
  });
});

describe('[CRÍTICO — AD-032] Pacientes — cadastro e validação', () => {
  it('cadastra e devolve exatamente os campos do contrato', async () => {
    const res = await createPatient(tokenA, clinicA);

    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['billingPolicyOverride', 'id', 'name', 'phone', 'state']);
    expect(res.body).toMatchObject({ name: VALID.name, phone: VALID.phone, billingPolicyOverride: null });
    expect((await stored(res.body.id)).tenantId).toBe(clinicA.tenantId);
  });

  it.each([
    ['nome com 1 caractere', { name: 'M', phone: VALID.phone }],
    ['telefone curto demais', { name: VALID.name, phone: '4199' }],
    ['sem nome', { phone: VALID.phone }],
    ['sem telefone', { name: VALID.name }],
    ['corpo vazio', {}],
    ['nome que não é texto', { name: 123, phone: VALID.phone }],
    ['campo que não existe no contrato', { ...VALID, tenantId: randomUUID() }],
    ['tentativa de escolher o estado', { ...VALID, state: 'Alta' }],
  ])('recusa %s: 400 e nada é gravado', async (_label, body) => {
    const before = await fixturePrisma.patient.count({ where: { tenantId: clinicA.tenantId } });

    const res = await createPatient(tokenA, clinicA, body);

    expect(res.status).toBe(400);
    expect(await fixturePrisma.patient.count({ where: { tenantId: clinicA.tenantId } })).toBe(before);
  });

  it('o paciente nasce na clínica de quem cadastra — nunca na que o corpo tentar indicar', async () => {
    const res = await createPatient(tokenA, clinicA, { ...VALID, name: 'Paciente Da Clínica A' });

    expect(res.status).toBe(201);
    expect((await stored(res.body.id)).tenantId).toBe(clinicA.tenantId);
    expect(await fixturePrisma.patient.count({ where: { tenantId: clinicB.tenantId, name: 'Paciente Da Clínica A' } })).toBe(0);
  });
});

describe('[CRÍTICO — AD-032] Pacientes — leitura e isolamento entre clínicas', () => {
  it('consulta um paciente da própria clínica', async () => {
    const created = await createPatient(tokenA, clinicA);

    const res = await api().get(`/api/v1/patients/${created.body.id}`).set(as(tokenA));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
  });

  it('id inexistente: 404', async () => {
    const res = await api().get(`/api/v1/patients/${randomUUID()}`).set(as(tokenA));

    expect(res.status).toBe(404);
  });

  it('paciente de outra clínica: 404, igual a um id que não existe — nem confirma que ele existe', async () => {
    const res = await api().get(`/api/v1/patients/${patientOfB}`).set(as(tokenA));
    const missing = await api().get(`/api/v1/patients/${randomUUID()}`).set(as(tokenA));

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe(missing.body.error.message);
    expect(JSON.stringify(res.body)).not.toContain('Paciente Dedicado');
  });

  it('a lista nunca traz paciente de outra clínica', async () => {
    await createPatient(tokenA, clinicA);

    const res = await api().get('/api/v1/patients?limit=200').set(as(tokenA));

    expect(res.status).toBe(200);
    const ids: string[] = res.body.data.map((patient: { id: string }) => patient.id);
    expect(ids).not.toContain(patientOfB);
    const owners = await fixturePrisma.patient.findMany({ where: { id: { in: ids } }, select: { tenantId: true } });
    expect(owners.every((owner) => owner.tenantId === clinicA.tenantId)).toBe(true);
  });

  it('paginação por cursor percorre todos os pacientes, sem repetir nem pular', async () => {
    for (let i = 0; i < 5; i += 1) await createPatient(tokenA, clinicA, { name: `Paciente Página ${i}`, phone: `+55419000022${i}0` });
    const expected = await fixturePrisma.patient.count({ where: { tenantId: clinicA.tenantId } });

    const collected: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const res = await api()
        .get(`/api/v1/patients?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
        .set(as(tokenA));
      expect(res.status).toBe(200);
      collected.push(...res.body.data.map((patient: { id: string }) => patient.id));
      cursor = res.body.next_cursor;
      if (!cursor) break;
    }

    expect(new Set(collected).size).toBe(collected.length);
    expect(collected).toHaveLength(expected);
  });

  it.each(['abc', '0', '-1', '1.5'])('limit=%s: 400, não erro interno', async (limit) => {
    const res = await api().get(`/api/v1/patients?limit=${limit}`).set(as(tokenA));

    expect(res.status).toBe(400);
  });
});

describe('[CRÍTICO — AD-032] Pacientes — alteração', () => {
  it('altera nome, telefone e política de cobrança — e o que a resposta diz é o que ficou gravado', async () => {
    const created = await createPatient(tokenA, clinicA);

    const res = await api()
      .patch(`/api/v1/patients/${created.body.id}`)
      .set(as(tokenA))
      .send({ name: 'Maria de Souza Lima', phone: '+5541911112222', billingPolicyOverride: 'monthly' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Maria de Souza Lima', phone: '+5541911112222', billingPolicyOverride: 'monthly' });
    const row = await stored(created.body.id);
    expect(row.name).toBe('Maria de Souza Lima');
    expect(row.phone).toBe('+5541911112222');
    expect(row.billingPolicyOverride).toBe('monthly');
    // E a leitura seguinte devolve o mesmo.
    expect((await api().get(`/api/v1/patients/${created.body.id}`).set(as(tokenA))).body.phone).toBe('+5541911112222');
  });

  it.each([
    ['política de cobrança desconhecida', { billingPolicyOverride: 'quinzenal' }],
    ['nome curto demais', { name: 'M' }],
    ['telefone curto demais', { phone: '123' }],
    ['campo que não existe no contrato', { state: 'Alta' }],
  ])('recusa %s: 400 e o cadastro não muda', async (_label, body) => {
    const created = await createPatient(tokenA, clinicA);

    const res = await api().patch(`/api/v1/patients/${created.body.id}`).set(as(tokenA)).send(body);

    expect(res.status).toBe(400);
    const row = await stored(created.body.id);
    expect({ name: row.name, phone: row.phone, state: row.state, billingPolicyOverride: row.billingPolicyOverride }).toEqual({
      name: VALID.name,
      phone: VALID.phone,
      state: created.body.state,
      billingPolicyOverride: null,
    });
  });

  it('id inexistente: 404', async () => {
    const res = await api().patch(`/api/v1/patients/${randomUUID()}`).set(as(tokenA)).send({ name: 'Nome Novo' });

    expect(res.status).toBe(404);
  });

  it.each([
    ['PATCH', '', { name: 'Invadido' }],
    ['POST', '/deactivate', {}],
    ['POST', '/reactivate', {}],
    ['POST', '/discharge', {}],
  ])('%s %s em paciente de outra clínica: 404 e o cadastro dela não muda', async (method, suffix, body) => {
    const before = await stored(patientOfB);

    const res = await (api() as unknown as Record<string, (path: string) => request.Test>)
      [method.toLowerCase()](`/api/v1/patients/${patientOfB}${suffix}`)
      .set(as(tokenA))
      .send(body);

    expect(res.status).toBe(404);
    const after = await stored(patientOfB);
    expect({ name: after.name, phone: after.phone, state: after.state }).toEqual({ name: before.name, phone: before.phone, state: before.state });
  });
});

describe('[CRÍTICO — AD-032] Pacientes — regras de estado', () => {
  async function patientIn(state: 'Ativo' | 'Inativo' | 'Alta' | 'Novo'): Promise<string> {
    const patient = await fixturePrisma.patient.create({ data: { tenantId: clinicA.tenantId, name: `Paciente ${state}`, phone: '+5541933334444', state } });
    clinicA.patientIds.push(patient.id);
    return patient.id;
  }

  it('inativa um paciente ativo e depois o reativa', async () => {
    const id = await patientIn('Ativo');

    const deactivated = await api().post(`/api/v1/patients/${id}/deactivate`).set(as(tokenA));
    expect(deactivated.status).toBe(201);
    expect(deactivated.body.state).toBe('Inativo');
    expect((await stored(id)).state).toBe('Inativo');

    const reactivated = await api().post(`/api/v1/patients/${id}/reactivate`).set(as(tokenA));
    expect(reactivated.status).toBe(201);
    expect((await stored(id)).state).toBe('Ativo');
  });

  it('alta é definitiva: paciente com alta não é reativado nem inativado', async () => {
    const id = await patientIn('Ativo');
    expect((await api().post(`/api/v1/patients/${id}/discharge`).set(as(tokenA))).status).toBe(201);
    expect((await stored(id)).state).toBe('Alta');

    const reactivate = await api().post(`/api/v1/patients/${id}/reactivate`).set(as(tokenA));
    const deactivate = await api().post(`/api/v1/patients/${id}/deactivate`).set(as(tokenA));

    expect(reactivate.status).toBeGreaterThanOrEqual(400);
    expect(deactivate.status).toBeGreaterThanOrEqual(400);
    expect((await stored(id)).state).toBe('Alta');
  });

  it('reativar quem não está inativo é recusado e o estado não muda', async () => {
    const id = await patientIn('Ativo');

    const res = await api().post(`/api/v1/patients/${id}/reactivate`).set(as(tokenA));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await stored(id)).state).toBe('Ativo');
  });

  it('inativar duas vezes: a segunda é recusada e o paciente segue inativo', async () => {
    const id = await patientIn('Ativo');
    expect((await api().post(`/api/v1/patients/${id}/deactivate`).set(as(tokenA))).status).toBe(201);

    const again = await api().post(`/api/v1/patients/${id}/deactivate`).set(as(tokenA));

    expect(again.status).toBeGreaterThanOrEqual(400);
    expect((await stored(id)).state).toBe('Inativo');
  });

  it('a clínica B continua vendo só os seus pacientes depois de tudo o que a A fez', async () => {
    const res = await api().get('/api/v1/patients?limit=200').set(as(tokenB));

    expect(res.status).toBe(200);
    expect(res.body.data.map((patient: { id: string }) => patient.id)).toEqual([patientOfB]);
  });
});
