import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPatientRepository } from '@infrastructure/database/repositories/prisma-patient.repository';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { TenantContext } from '@shared/tenant-context';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from '../../critical/support/dedicated-fixture';

/**
 * Fase 3B da auditoria (ADR-0059) — busca de paciente pelo telefone, contra
 * Postgres real e sob RLS.
 *
 * O telefone do paciente é texto livre e continua gravado como foi
 * digitado. O que mudou é a comparação: forma normalizada dos dois lados,
 * pela mesma regra do Contact (PhoneNumber, só Brasil). Estes testes fixam
 * cada grafia aceita, o que NÃO pode casar e o isolamento entre clínicas.
 */

function ensureDatabaseUrl(): void {
  if (process.env.DATABASE_URL) {
    return;
  }
  const envPath = path.resolve(__dirname, '../../../.env');
  const content = readFileSync(envPath, 'utf-8');
  const match = content.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/m);
  if (!match) {
    throw new Error(`DATABASE_URL não encontrado em ${envPath}`);
  }
  process.env.DATABASE_URL = match[1];
}

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

ensureDatabaseUrl();

let fixturePrisma: PrismaClient;
let fixtureA: DedicatedFixture;
let fixtureB: DedicatedFixture;
let clientProvider: PrismaClientProvider;
let repoA: PrismaPatientRepository;
let repoB: PrismaPatientRepository;

function repositoryForTenant(tenantId: string): PrismaPatientRepository {
  const tenantContext = new TenantContext();
  tenantContext.set(tenantId, null);
  return new PrismaPatientRepository(new PrismaService(clientProvider, tenantContext));
}

/** Um celular novo a cada chamada: DDD + 9 + 8 dígitos (11 dígitos, sem código do país). */
function newMobile(ddd = '41'): string {
  return `${ddd}9${Math.floor(Math.random() * 90000000 + 10000000)}`;
}

async function createPatient(fixture: DedicatedFixture, phone: string, createdAt?: Date) {
  const patient = await fixturePrisma.patient.create({
    data: { tenantId: fixture.tenantId, name: `Paciente telefone ${phone}`, phone, ...(createdAt ? { createdAt } : {}) },
  });
  fixture.patientIds.push(patient.id);
  return patient;
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();

  fixtureA = await createDedicatedFixture(fixturePrisma, 'F3BPHONEA');
  fixtureB = await createDedicatedFixture(fixturePrisma, 'F3BPHONEB');

  clientProvider = new PrismaClientProvider();
  repoA = repositoryForTenant(fixtureA.tenantId);
  repoB = repositoryForTenant(fixtureB.tenantId);
});

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, fixtureA);
  await cleanupDedicatedFixture(fixturePrisma, fixtureB);
  await clientProvider.$disconnect();
  await fixturePrisma.$disconnect();
});

describe('[Fase 3B] PrismaPatientRepository.findByPhone — comparação normalizada', () => {
  it.each<[string, (national: string) => string]>([
    ['E.164, com "+"', (n) => `+55${n}`],
    ['com "+", espaços, parênteses e hífen', (n) => `+55 (${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`],
    ['só dígitos, com o código do país', (n) => `55${n}`],
    ['máscara, sem o código do país', (n) => `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`],
    ['espaços, sem o código do país', (n) => `${n.slice(0, 2)} ${n.slice(2, 7)} ${n.slice(7)}`],
    ['só dígitos, sem o código do país', (n) => n],
  ])('telefone gravado %s é encontrado pelo número como a Meta envia (só dígitos, com 55)', async (_label, stored) => {
    const national = newMobile();
    const patient = await createPatient(fixtureA, stored(national));

    const found = await repoA.findByPhone(`55${national}`);

    expect(found?.id).toBe(patient.id);
    // O dado gravado não é reescrito.
    expect(found?.phone).toBe(stored(national));
  });

  it('a grafia do número PROCURADO também não importa', async () => {
    const national = newMobile();
    const patient = await createPatient(fixtureA, `(${national.slice(0, 2)}) ${national.slice(2, 7)}-${national.slice(7)}`);

    for (const searched of [`55${national}`, `+55${national}`, national, `+55 ${national.slice(0, 2)} ${national.slice(2)}`]) {
      expect((await repoA.findByPhone(searched))?.id).toBe(patient.id);
    }
  });

  it('telefone fixo (8 dígitos depois do DDD) é encontrado sem inventar o nono dígito', async () => {
    const landline = `41${Math.floor(Math.random() * 3000000 + 30000000)}`;
    const patient = await createPatient(fixtureA, `(41) ${landline.slice(2, 6)}-${landline.slice(6)}`);

    expect((await repoA.findByPhone(`55${landline}`))?.id).toBe(patient.id);
  });

  it('DDD 55 (interior do RS) gravado sem o código do país é encontrado', async () => {
    const national = newMobile('55');
    const patient = await createPatient(fixtureA, `(55) ${national.slice(2, 7)}-${national.slice(7)}`);

    expect((await repoA.findByPhone(`55${national}`))?.id).toBe(patient.id);
  });

  it('número diferente não casa', async () => {
    const national = newMobile();
    await createPatient(fixtureA, national);

    expect(await repoA.findByPhone(`55${newMobile()}`)).toBeNull();
  });

  it('número de outro país gravado com "+" não é confundido com DDD + número', async () => {
    // "+51 9XXXXXXXX" é um celular do Peru; sem o "+", os mesmos dígitos
    // seriam um celular de Porto Alegre (DDD 51).
    const digits = newMobile('51');
    await createPatient(fixtureA, `+${digits.slice(0, 2)} ${digits.slice(2)}`);

    expect(await repoA.findByPhone(`55${digits}`)).toBeNull();
  });

  it('isolamento: o mesmo telefone cadastrado em outra clínica nunca é devolvido', async () => {
    const national = newMobile();
    const patientB = await createPatient(fixtureB, `+55${national}`);

    expect(await repoA.findByPhone(`55${national}`)).toBeNull();
    expect((await repoB.findByPhone(`55${national}`))?.id).toBe(patientB.id);
  });

  it('dois pacientes com o mesmo telefone (familiares): devolve sempre o cadastro mais antigo', async () => {
    const national = newMobile();
    const newer = await createPatient(fixtureA, `+55${national}`, new Date('2026-06-01T12:00:00Z'));
    const older = await createPatient(fixtureA, `(${national.slice(0, 2)}) ${national.slice(2)}`, new Date('2026-01-01T12:00:00Z'));

    const found = await repoA.findByPhone(`55${national}`);

    expect(found?.id).toBe(older.id);
    expect(found?.id).not.toBe(newer.id);
  });

  it('número procurado que não é do Brasil: vale a comparação exata de antes', async () => {
    const foreign = `3519${Math.floor(Math.random() * 90000000 + 10000000)}`;
    const patient = await createPatient(fixtureA, foreign);

    expect((await repoA.findByPhone(foreign))?.id).toBe(patient.id);
    expect(await repoA.findByPhone(`+${foreign.slice(0, 3)} ${foreign.slice(3)}`)).toBeNull();
  });
});
