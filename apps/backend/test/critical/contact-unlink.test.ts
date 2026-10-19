import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, UserRole } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, cleanupDedicatedFixture, createDedicatedUserAndLogin, DedicatedFixture } from './support/dedicated-fixture';

/**
 * [CRÍTICO — A-10] Desfazer um vínculo de número aprovado pela clínica, de
 * ponta a ponta: rota, RBAC, RLS, banco e trilha de auditoria. Até 19/10/2026
 * não havia como: um vínculo aprovado por engano só se corrigia no banco.
 */

interface Clinic {
  fixture: DedicatedFixture;
  tenantId: string;
}

let app: INestApplication;
let db: PrismaClient;
let clinicA: Clinic;
let clinicB: Clinic;
let adminA: { token: string; userId: string };
let therapistA: string;
let adminB: string;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

let phoneSequence = 0;
function nextPhone(): string {
  phoneSequence += 1;
  return `+55319${String(60000000 + phoneSequence + Math.floor(Math.random() * 9000000)).padStart(8, '0')}`;
}

async function createClinic(label: string): Promise<Clinic> {
  const fixture = await createDedicatedFixture(db, label, { withActiveSubscription: true });
  return { fixture, tenantId: fixture.tenantId };
}

async function patient(clinic: Clinic, phone = nextPhone()): Promise<string> {
  const row = await db.patient.create({ data: { tenantId: clinic.tenantId, name: `Paciente ${randomUUID()} Teste`, phone, state: 'Ativo' } });
  clinic.fixture.patientIds.push(row.id);
  return row.id;
}

async function pendingContact(clinic: Clinic): Promise<string> {
  const row = await db.contact.create({
    data: { tenantId: clinic.tenantId, phoneNumber: nextPhone(), name: 'Nome Informado Teste', state: 'Identificado' },
  });
  return row.id;
}

async function approve(contactId: string, patientId: string): Promise<void> {
  const res = await request(app.getHttpServer())
    .post(`/api/v1/contacts/${contactId}/link`)
    .set('Authorization', `Bearer ${adminA.token}`)
    .send({ patientId });
  expect(res.status).toBe(201);
}

const unlink = (token: string, contactId: string, patientId: string) =>
  request(app.getHttpServer()).post(`/api/v1/contacts/${contactId}/unlink`).set('Authorization', `Bearer ${token}`).send({ patientId });

const get = (token: string, path: string) => request(app.getHttpServer()).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

async function snapshot(contactId: string) {
  const contact = await db.contact.findUniqueOrThrow({ where: { id: contactId }, include: { associations: true } });
  const audits = await db.auditLog.findMany({ where: { entityId: contactId, action: 'ContatoDesvinculadoDePaciente' } });
  return { state: contact.state, name: contact.name, patientIds: contact.associations.map((a) => a.patientId), audits };
}

async function cleanupClinic(clinic: Clinic | undefined): Promise<void> {
  if (!clinic) return;
  await db.contactPatientAssociation.deleteMany({ where: { tenantId: clinic.tenantId } });
  await db.contact.deleteMany({ where: { tenantId: clinic.tenantId } });
  await cleanupDedicatedFixture(db, clinic.fixture);
}

beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await db.$connect();
  app = await bootstrapTestApp();

  clinicA = await createClinic('UNLINKA');
  clinicB = await createClinic('UNLINKB');
  const tokenA = await createDedicatedUserAndLogin(db, app, clinicA.fixture, 'UNLINKA', UserRole.admin);
  adminA = { token: tokenA, userId: clinicA.fixture.userId as string };
  therapistA = await createDedicatedUserAndLogin(db, app, clinicA.fixture, 'UNLINKA', UserRole.therapist);
  adminB = await createDedicatedUserAndLogin(db, app, clinicB.fixture, 'UNLINKB', UserRole.admin);
}, 90_000);

afterAll(async () => {
  await app?.close();
  if (db) {
    await cleanupClinic(clinicA);
    await cleanupClinic(clinicB);
    await db.$disconnect();
  }
}, 90_000);

describe('[CRÍTICO — A-10] desfazer um vínculo aprovado', () => {
  it('o administrador vê o vínculo aprovado, desfaz, e o número volta a aguardar vínculo — com registro de quem desfez', async () => {
    const contactId = await pendingContact(clinicA);
    const patientId = await patient(clinicA);
    await approve(contactId, patientId);

    const listed = await get(adminA.token, '/contacts/linked');
    expect(listed.status).toBe(200);
    expect(listed.body.data).toContainEqual(expect.objectContaining({ contactId, patientId }));

    const res = await unlink(adminA.token, contactId, patientId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ contactId, patientId, state: 'Identificado', undoneByUserId: adminA.userId });

    const after = await snapshot(contactId);
    expect(after.state).toBe('Identificado');
    expect(after.name).toBe('Nome Informado Teste');
    expect(after.patientIds).toEqual([]);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({ tenantId: clinicA.tenantId, userId: adminA.userId });
    expect(after.audits[0].payload).toMatchObject({ patientId, undoneByUserId: adminA.userId, undoneAt: res.body.undoneAt });

    expect((await get(adminA.token, '/contacts/linked')).body.data).not.toContainEqual(expect.objectContaining({ contactId }));
    expect((await get(adminA.token, '/contacts/pending')).body.data).toContainEqual(expect.objectContaining({ id: contactId }));
  });

  it('o contato, o vínculo apagado e o registro de auditoria saem da mesma transação do banco', async () => {
    const contactId = await pendingContact(clinicA);
    const patientId = await patient(clinicA);
    await approve(contactId, patientId);

    expect((await unlink(adminA.token, contactId, patientId)).status).toBe(200);

    const contactXid = await db.$queryRaw<Array<{ xid: string }>>`SELECT xmin::text AS xid FROM contact WHERE id = ${contactId}`;
    const auditXid = await db.$queryRaw<Array<{ xid: string }>>`
      SELECT xmin::text AS xid FROM audit_log WHERE entity_id = ${contactId} AND action = 'ContatoDesvinculadoDePaciente'
    `;
    expect(auditXid).toHaveLength(1);
    expect(auditXid[0].xid).toBe(contactXid[0].xid);
  });

  it('desfazer de novo: 404, nada muda', async () => {
    const contactId = await pendingContact(clinicA);
    const patientId = await patient(clinicA);
    await approve(contactId, patientId);
    expect((await unlink(adminA.token, contactId, patientId)).status).toBe(200);
    const before = await snapshot(contactId);

    expect((await unlink(adminA.token, contactId, patientId)).status).toBe(404);
    expect(await snapshot(contactId)).toEqual(before);
  });

  it('terapeuta: 403 nas duas rotas, e o vínculo fica', async () => {
    const contactId = await pendingContact(clinicA);
    const patientId = await patient(clinicA);
    await approve(contactId, patientId);

    expect((await get(therapistA, '/contacts/linked')).status).toBe(403);
    expect((await unlink(therapistA, contactId, patientId)).status).toBe(403);
    const after = await snapshot(contactId);
    expect(after.state).toBe('Vinculado');
    expect(after.patientIds).toEqual([patientId]);
    expect(after.audits).toHaveLength(0);
  });

  it('administrador de outra clínica: não vê na lista, recebe 404 e não deixa registro', async () => {
    const contactId = await pendingContact(clinicA);
    const patientId = await patient(clinicA);
    await approve(contactId, patientId);

    expect((await get(adminB, '/contacts/linked')).body.data).not.toContainEqual(expect.objectContaining({ contactId }));
    expect((await unlink(adminB, contactId, patientId)).status).toBe(404);
    const after = await snapshot(contactId);
    expect(after.state).toBe('Vinculado');
    expect(after.patientIds).toEqual([patientId]);
    expect(after.audits).toHaveLength(0);
    expect(await db.auditLog.count({ where: { tenantId: clinicB.tenantId, action: 'ContatoDesvinculadoDePaciente' } })).toBe(0);
  });

  it('número que está no cadastro do próprio paciente: fora da lista, e desfazer responde 409 — o cadastro é que identifica', async () => {
    const phone = nextPhone();
    const patientId = await patient(clinicA, phone);
    const contact = await db.contact.create({ data: { tenantId: clinicA.tenantId, phoneNumber: phone, name: 'Pelo Cadastro', state: 'Vinculado' } });
    await db.contactPatientAssociation.create({ data: { tenantId: clinicA.tenantId, contactId: contact.id, patientId, role: 'proprio_paciente' } });

    expect((await get(adminA.token, '/contacts/linked')).body.data).not.toContainEqual(expect.objectContaining({ contactId: contact.id }));
    const res = await unlink(adminA.token, contact.id, patientId);
    expect(res.status).toBe(409);
    const after = await snapshot(contact.id);
    expect(after.state).toBe('Vinculado');
    expect(after.patientIds).toEqual([patientId]);
  });

  it('corpo sem patientId válido: 400', async () => {
    const contactId = await pendingContact(clinicA);
    expect((await unlink(adminA.token, contactId, 'nao-e-uuid')).status).toBe(400);
  });
});
