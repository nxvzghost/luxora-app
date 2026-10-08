import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { PrismaRecurringBlockRepository } from '@infrastructure/database/repositories/prisma-recurring-block.repository';
import { RecurringBlock } from '@domain/availability/recurring-block.entity';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * PD-001 Fase 2, C2 — persistência de RecurringBlock (Aggregate Root
 * independente, ver relatório da C1). Não é um dos 16 Testes Críticos
 * documentados em docs/09-Testes/ — prova o Repository diretamente (sem
 * HTTP, sem Controller ainda), mesmo formato de
 * clinic-holiday-persistence.test.ts (B3). tenantId explícito em cada
 * chamada — o próprio contrato exige isso, ver RecurringBlockRepository.
 *
 * AD-035 (Tarefa 06 da auditoria): usava as clínicas do seed ("Clínica
 * Teste A/B") e nunca apagava os horários fixos que gravava — a cada
 * execução ficavam mais registros na clínica de desenvolvimento. Agora
 * cada execução cria e remove as suas duas clínicas, pela fixture dedicada.
 */

let client: PrismaClientProvider;
let tenantAId: string;
let tenantBId: string;
let patientId: string;
let therapistId: string;
let fixtureA: DedicatedFixture;
let fixtureB: DedicatedFixture;

// A preparação roda como superusuário (a RLS bloquearia a criação das clínicas sem
// app.tenant_id já setado) — a prova de persistência em si roda pela role
// real (luxora_app), via PrismaRecurringBlockRepository, sujeita a RLS.
function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}
const fixturePrisma = new PrismaClient({
  datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } },
});

function newBlock(tenantId: string, overrides: Partial<{ patientId: string; therapistId: string }> = {}) {
  return RecurringBlock.create({
    id: randomUUID(),
    tenantId,
    patientId: overrides.patientId ?? patientId,
    therapistId: overrides.therapistId ?? therapistId,
    firstOccurrence: new Date('2026-08-04T14:00:00'),
    intervalDays: 7,
    modality: 'presencial',
    renewalMode: 'automatic',
  });
}

beforeAll(async () => {
  client = new PrismaClientProvider();
  await client.$connect();
  await fixturePrisma.$connect();

  fixtureA = await createDedicatedFixture(fixturePrisma, 'C2PERSIST-A');
  fixtureB = await createDedicatedFixture(fixturePrisma, 'C2PERSIST-B');
  tenantAId = fixtureA.tenantId;
  tenantBId = fixtureB.tenantId;
  patientId = fixtureA.patientId;
  therapistId = fixtureA.therapistId;
});

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, fixtureA);
  await cleanupDedicatedFixture(fixturePrisma, fixtureB);
  await client.$disconnect();
  await fixturePrisma.$disconnect();
});

describe('PrismaRecurringBlockRepository — persistência (C2)', () => {
  it('save() persiste e findById() retorna o registro (round-trip)', async () => {
    const repo = new PrismaRecurringBlockRepository(client);
    const block = newBlock(tenantAId);

    await repo.save(block);

    const found = await repo.findById(tenantAId, block.id);
    expect(found?.id).toBe(block.id);
    expect(found?.patientId).toBe(patientId);
    expect(found?.therapistId).toBe(therapistId);
    expect(found?.intervalDays).toBe(7);
    expect(found?.modality).toBe('presencial');
    expect(found?.renewalMode).toBe('automatic');
    expect(found?.firstOccurrence.toISOString()).toBe(new Date('2026-08-04T14:00:00').toISOString());
  });

  it('findById() NUNCA retorna um registro de outro tenant, mesmo com o id correto (RLS)', async () => {
    const repo = new PrismaRecurringBlockRepository(client);
    const block = newBlock(tenantAId);
    await repo.save(block);

    const foundAsB = await repo.findById(tenantBId, block.id);
    expect(foundAsB).toBeNull();

    const foundAsA = await repo.findById(tenantAId, block.id);
    expect(foundAsA?.id).toBe(block.id);
  });

  it('findById() retorna null para id inexistente', async () => {
    const repo = new PrismaRecurringBlockRepository(client);
    const found = await repo.findById(tenantAId, randomUUID());
    expect(found).toBeNull();
  });
});
