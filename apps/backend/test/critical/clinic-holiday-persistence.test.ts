import { randomUUID, randomInt } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { PrismaClinicHolidayRepository } from '@infrastructure/database/repositories/prisma-clinic-holiday.repository';
import { ClinicHoliday } from '@domain/availability/clinic-holiday.entity';

/**
 * PD-001 Fase 2, itens B3 (persistência) e B5 (findById/delete, gerenciamento)
 * de ClinicHoliday.
 *
 * Não é um dos 16 Testes Críticos documentados em docs/09-Testes/ — prova
 * o Repository diretamente (sem HTTP, sem Controller ainda). tenantId
 * explícito em cada chamada — o próprio contrato exige isso, ver
 * ClinicHolidayRepository.
 */

let client: PrismaClientProvider;
let tenantAId: string;
let tenantBId: string;

// Lookup de seed roda como superusuário (RLS bloquearia um findFirst sem
// app.tenant_id já setado) — a prova de persistência em si roda pela role
// real (luxora_app), via PrismaClinicHolidayRepository, sujeita a RLS.
function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}
const fixturePrisma = new PrismaClient({
  datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } },
});

// Mesmo raciocínio de test/critical/support/unique-slot.ts: âncora
// aleatória bem afastada, sorteada uma vez por execução do processo — evita
// colisão com dado deixado por rodadas anteriores deste mesmo arquivo (sem
// limpeza entre execuções, banco de desenvolvimento persistente) e com
// outros arquivos de teste crítico rodando em paralelo.
const ANCHOR_DAYS_AHEAD = randomInt(30, 9970);

function dateAt(daysFromAnchor: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + ANCHOR_DAYS_AHEAD + daysFromAnchor);
  date.setHours(0, 0, 0, 0);
  return date;
}

function newHoliday(tenantId: string, from: Date, to: Date, reason?: string) {
  return ClinicHoliday.create({ id: randomUUID(), tenantId, from, to, reason });
}

beforeAll(async () => {
  client = new PrismaClientProvider();
  await client.$connect();
  await fixturePrisma.$connect();

  const tenantA = await fixturePrisma.tenant.findFirst({ where: { name: 'Clínica Teste A' } });
  const tenantB = await fixturePrisma.tenant.findFirst({ where: { name: 'Clínica Teste B' } });
  if (!tenantA || !tenantB) {
    throw new Error('Seed de desenvolvimento (Tenant A/B) não encontrado — rode pnpm --filter @luxora/backend seed antes deste teste.');
  }
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;
});

afterAll(async () => {
  await client.$disconnect();
  await fixturePrisma.$disconnect();
});

describe('PrismaClinicHolidayRepository — persistência (B3)', () => {
  it('save() persiste e findByTenantAndRange() retorna o registro (round-trip)', async () => {
    const repo = new PrismaClinicHolidayRepository(client);
    const holiday = newHoliday(tenantAId, dateAt(0), dateAt(2), 'natal');

    await repo.save(holiday);

    const found = await repo.findByTenantAndRange(tenantAId, dateAt(1), dateAt(1));
    expect(found.map((h) => h.id)).toContain(holiday.id);
    const match = found.find((h) => h.id === holiday.id);
    expect(match?.reason).toBe('natal');
  });

  it('RLS: feriado do Tenant A é invisível ao consultar com tenantId do Tenant B', async () => {
    const repo = new PrismaClinicHolidayRepository(client);
    const holiday = newHoliday(tenantAId, dateAt(10), dateAt(11));
    await repo.save(holiday);

    const foundAsB = await repo.findByTenantAndRange(tenantBId, dateAt(10), dateAt(11));
    expect(foundAsB.find((h) => h.id === holiday.id)).toBeUndefined();

    const foundAsA = await repo.findByTenantAndRange(tenantAId, dateAt(10), dateAt(11));
    expect(foundAsA.find((h) => h.id === holiday.id)).toBeDefined();
  });

  it('findByTenantAndRange() retorna exclusivamente os feriados que intersectam o intervalo, entre vários cadastrados', async () => {
    const repo = new PrismaClinicHolidayRepository(client);

    const withinRange1 = newHoliday(tenantAId, dateAt(20), dateAt(22)); // intersecta a janela consultada
    const withinRange2 = newHoliday(tenantAId, dateAt(24), dateAt(25)); // intersecta (totalmente contido)
    const outsideRange = newHoliday(tenantAId, dateAt(40), dateAt(41)); // fora, não deve aparecer
    const adjacentNoOverlap = newHoliday(tenantAId, dateAt(26), dateAt(27)); // adjacente ao fim da janela, sem sobreposição real

    await repo.save(withinRange1);
    await repo.save(withinRange2);
    await repo.save(outsideRange);
    await repo.save(adjacentNoOverlap);

    // Janela consultada: dateAt(20.5) até dateAt(26) — meio-dia do primeiro até o início do adjacente
    const queryFrom = new Date(dateAt(20).getTime() + 12 * 60 * 60 * 1000);
    const results = await repo.findByTenantAndRange(tenantAId, queryFrom, dateAt(26));

    const resultIds = results.map((h) => h.id);
    expect(resultIds).toContain(withinRange1.id);
    expect(resultIds).toContain(withinRange2.id);
    expect(resultIds).not.toContain(outsideRange.id);
    expect(resultIds).not.toContain(adjacentNoOverlap.id);
  });

  it('findById() retorna o registro quando pertence ao tenantId consultado (round-trip)', async () => {
    const repo = new PrismaClinicHolidayRepository(client);
    const holiday = newHoliday(tenantAId, dateAt(50), dateAt(51), 'confraternização');

    await repo.save(holiday);

    const found = await repo.findById(tenantAId, holiday.id);
    expect(found?.id).toBe(holiday.id);
    expect(found?.reason).toBe('confraternização');
  });

  it('findById() NUNCA retorna um registro de outro tenant, mesmo com o id correto', async () => {
    const repo = new PrismaClinicHolidayRepository(client);
    const holiday = newHoliday(tenantAId, dateAt(55), dateAt(56));
    await repo.save(holiday);

    const foundAsB = await repo.findById(tenantBId, holiday.id);
    expect(foundAsB).toBeNull();

    const foundAsA = await repo.findById(tenantAId, holiday.id);
    expect(foundAsA?.id).toBe(holiday.id);
  });

  it('findById() retorna null para id inexistente', async () => {
    const repo = new PrismaClinicHolidayRepository(client);
    const found = await repo.findById(tenantAId, randomUUID());
    expect(found).toBeNull();
  });

  it('delete() remove o registro — findById() confirma ausência depois', async () => {
    const repo = new PrismaClinicHolidayRepository(client);
    const holiday = newHoliday(tenantAId, dateAt(60), dateAt(61));
    await repo.save(holiday);
    expect(await repo.findById(tenantAId, holiday.id)).not.toBeNull();

    await repo.delete(tenantAId, holiday.id);

    expect(await repo.findById(tenantAId, holiday.id)).toBeNull();
  });

  it('delete() com tenantId de outro tenant NÃO remove o registro (isolamento também na escrita)', async () => {
    const repo = new PrismaClinicHolidayRepository(client);
    const holiday = newHoliday(tenantAId, dateAt(65), dateAt(66));
    await repo.save(holiday);

    await repo.delete(tenantBId, holiday.id); // tenant errado — não deve afetar nada

    const stillThere = await repo.findById(tenantAId, holiday.id);
    expect(stillThere?.id).toBe(holiday.id);
  });
});
