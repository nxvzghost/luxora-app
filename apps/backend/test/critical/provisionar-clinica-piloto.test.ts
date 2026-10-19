import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { provisionarClinicaPiloto, ProvisionamentoRecusadoError } from '../../src/cli/provisionar-clinica-piloto';

/**
 * [CRÍTICO — A-16] Entrada da clínica piloto por provisionamento manual, sem
 * cobrança (ADR-0066, docs/07-Infra/ENTRADA_CLINICA_PILOTO.md). O script roda
 * com a conexão da aplicação, sob RLS; depois, o administrador cria o próprio
 * acesso pela rota pública que já existe e usa o painel como qualquer clínica.
 */

let app: INestApplication;
let appDb: PrismaClient;
let db: PrismaClient;
const created: string[] = [];

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

const uniqueName = () => `Clínica Piloto Teste ${randomUUID().slice(0, 8)}`;

async function provision(input: Parameters<typeof provisionarClinicaPiloto>[1]) {
  const result = await provisionarClinicaPiloto(appDb, input);
  created.push(result.tenantId);
  return result;
}

beforeAll(async () => {
  appDb = new PrismaClient();
  db = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await db.$connect();
  app = await bootstrapTestApp();
}, 90_000);

afterAll(async () => {
  await app?.close();
  if (db) {
    for (const tenantId of created) {
      await db.auditLog.deleteMany({ where: { tenantId } });
      await db.user.deleteMany({ where: { tenantId } });
      await db.clinicSubscription.deleteMany({ where: { tenantId } });
      await db.aiSettings.deleteMany({ where: { tenantId } });
      await db.clinicSettings.deleteMany({ where: { tenantId } });
      await db.tenant.deleteMany({ where: { id: tenantId } });
    }
    await db.$disconnect();
  }
  await appDb?.$disconnect();
}, 90_000);

describe('[CRÍTICO — A-16] provisionamento da clínica piloto', () => {
  it('cria a clínica, as configurações, a assinatura de cortesia (sem Asaas) e o registro na auditoria — numa transação só', async () => {
    const name = uniqueName();
    const result = await provision({ name, timeZone: 'America/Manaus' });

    expect(result).toMatchObject({ name, plan: 'enterprise', timeZone: 'America/Manaus' });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: result.tenantId } })).name).toBe(name);
    expect((await db.clinicSettings.findUniqueOrThrow({ where: { tenantId: result.tenantId } })).timeZone).toBe('America/Manaus');
    expect(await db.aiSettings.count({ where: { tenantId: result.tenantId } })).toBe(1);
    expect(await db.clinicSubscription.findUniqueOrThrow({ where: { tenantId: result.tenantId } })).toMatchObject({
      plan: 'enterprise',
      status: 'active',
      asaasCustomerId: null,
      asaasSubscriptionId: null,
    });
    const audit = await db.auditLog.findMany({ where: { tenantId: result.tenantId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'ClinicaProvisionadaParaPiloto', actorType: 'system', entityId: result.tenantId });
    expect(audit[0].payload).toMatchObject({ plan: 'enterprise', timeZone: 'America/Manaus', cortesia: true });

    // Transação só: o registro da clínica e o da auditoria saem da mesma transação do banco.
    const [tenantXid] = await db.$queryRaw<Array<{ xid: string }>>`SELECT xmin::text AS xid FROM tenant WHERE id = ${result.tenantId}`;
    const [auditXid] = await db.$queryRaw<Array<{ xid: string }>>`SELECT xmin::text AS xid FROM audit_log WHERE tenant_id = ${result.tenantId}`;
    expect(auditXid.xid).toBe(tenantXid.xid);
  });

  it('o administrador cria o próprio acesso pela rota que já existe, entra e usa o painel — sem cobrança de assinatura', async () => {
    const result = await provision({ name: uniqueName() });
    const email = `admin-${randomUUID()}@piloto.luxora.dev`;

    const bootstrap = await request(app.getHttpServer())
      .post('/api/v1/users/bootstrap-admin')
      .send({ tenantId: result.tenantId, email, password: 'senha-de-teste-piloto-2026' });
    expect(bootstrap.status).toBe(201);
    const token = bootstrap.body.accessToken as string;

    const patients = await request(app.getHttpServer()).get('/api/v1/patients').set('Authorization', `Bearer ${token}`);
    expect(patients.status).toBe(200);
    const clinic = await request(app.getHttpServer()).get('/api/v1/clinic').set('Authorization', `Bearer ${token}`);
    expect(clinic.status).toBe(200);
    expect(JSON.stringify(clinic.body)).toContain('America/Sao_Paulo');

    // Um segundo "primeiro administrador" é recusado pela regra que já existia.
    const second = await request(app.getHttpServer())
      .post('/api/v1/users/bootstrap-admin')
      .send({ tenantId: result.tenantId, email: `outro-${randomUUID()}@piloto.luxora.dev`, password: 'senha-de-teste-piloto-2026' });
    expect(second.status).not.toBe(201);
  });

  it('nome repetido (sem diferenciar maiúsculas): recusado, nada criado', async () => {
    const name = uniqueName();
    await provision({ name });
    await expect(provisionarClinicaPiloto(appDb, { name: name.toUpperCase() })).rejects.toBeInstanceOf(ProvisionamentoRecusadoError);
    expect(await db.tenant.count({ where: { name: { equals: name, mode: 'insensitive' } } })).toBe(1);
  });

  it.each([
    ['sem nome', { name: '  ' }],
    ['fuso que não é da base IANA', { name: 'Clínica Fuso Errado Teste', timeZone: 'GMT-3' }],
    ['plano que não existe', { name: 'Clínica Plano Errado Teste', plan: 'gratis' }],
  ])('%s: recusado, nada criado', async (_label, input) => {
    const before = await db.tenant.count();
    await expect(provisionarClinicaPiloto(appDb, input)).rejects.toBeInstanceOf(ProvisionamentoRecusadoError);
    expect(await db.tenant.count()).toBe(before);
  });
});
