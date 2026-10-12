import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BillingStatus, PrismaClient } from '@prisma/client';
import { PrismaAvailabilityRepository } from '@infrastructure/database/repositories/prisma-availability.repository';
import { PrismaBillingRepository } from '@infrastructure/database/repositories/prisma-billing.repository';
import { PrismaClinicRepository } from '@infrastructure/database/repositories/prisma-clinic.repository';
import { PrismaClinicTimeZoneReader } from '@infrastructure/database/prisma-clinic-time-zone.reader';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { TenantContext } from '@shared/tenant-context';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from '../../critical/support/dedicated-fixture';

/**
 * AD-039 (ADR-0064) — fuso por clínica, contra Postgres real e sob RLS.
 *
 * O que só o banco prova: a coluna nova com o padrão para as clínicas que já
 * existiam, a leitura isolada por clínica, e o filtro da contagem de
 * cobranças em atraso — que tem de dar a mesma resposta que a regra da
 * entidade, instante por instante, em cada fuso.
 *
 * Os instantes de referência são passados ao repositório (2031, longe de
 * qualquer "hoje"): nada aqui depende da hora em que o teste roda, nem do
 * fuso do processo.
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
let clientProvider: PrismaClientProvider;
let saoPaulo: DedicatedFixture; // clínica com a configuração criada sem dizer o fuso: recebe o padrão
let manaus: DedicatedFixture;
let noSettings: DedicatedFixture; // clínica sem linha em clinic_settings

function prismaFor(tenantId: string): PrismaService {
  const tenantContext = new TenantContext();
  tenantContext.set(tenantId, null);
  return new PrismaService(clientProvider, tenantContext);
}

async function setTimeZone(fixture: DedicatedFixture, timeZone: string): Promise<void> {
  await fixturePrisma.clinicSettings.update({ where: { tenantId: fixture.tenantId }, data: { timeZone } });
}

async function createBilling(fixture: DedicatedFixture, dueDate: string, status: BillingStatus): Promise<void> {
  const billing = await fixturePrisma.billing.create({
    data: { tenantId: fixture.tenantId, patientId: fixture.patientId, amount: 100, dueDate: new Date(dueDate), status },
  });
  fixture.billingIds.push(billing.id);
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  clientProvider = new PrismaClientProvider();

  saoPaulo = await createDedicatedFixture(fixturePrisma, 'AD039SP', { withClinicSettings: true, withAvailabilityCalendar: true });
  manaus = await createDedicatedFixture(fixturePrisma, 'AD039AM', { withClinicSettings: true, withAvailabilityCalendar: true });
  noSettings = await createDedicatedFixture(fixturePrisma, 'AD039NONE', { withAvailabilityCalendar: true });
  await setTimeZone(manaus, 'America/Manaus');
});

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, saoPaulo);
  await cleanupDedicatedFixture(fixturePrisma, manaus);
  await cleanupDedicatedFixture(fixturePrisma, noSettings);
  await clientProvider.$disconnect();
  await fixturePrisma.$disconnect();
});

describe('[AD-039] fuso da clínica em clinic_settings', () => {
  it('a coluna existe, é obrigatória e tem America/Sao_Paulo como padrão', async () => {
    const [column] = await fixturePrisma.$queryRaw<Array<{ data_type: string; is_nullable: string; column_default: string }>>`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'clinic_settings' AND column_name = 'time_zone'`;

    expect(column).toEqual({ data_type: 'text', is_nullable: 'NO', column_default: "'America/Sao_Paulo'::text" });
  });

  it('clínica cuja configuração foi gravada sem fuso (como todas as que já existiam) lê o padrão, sem intervenção', async () => {
    expect(await new PrismaClinicTimeZoneReader(prismaFor(saoPaulo.tenantId)).current()).toBe('America/Sao_Paulo');
  });

  it('nenhuma clínica do banco ficou sem fuso depois da migration', async () => {
    const [{ missing }] = await fixturePrisma.$queryRaw<Array<{ missing: bigint }>>`
      SELECT count(*) AS missing FROM clinic_settings WHERE time_zone IS NULL OR time_zone = ''`;

    expect(Number(missing)).toBe(0);
  });

  it('clínica sem linha de configuração também recebe o padrão', async () => {
    expect(await new PrismaClinicTimeZoneReader(prismaFor(noSettings.tenantId)).current()).toBe('America/Sao_Paulo');
  });

  it('cada clínica lê o seu fuso, e só o seu', async () => {
    expect(await new PrismaClinicTimeZoneReader(prismaFor(manaus.tenantId)).current()).toBe('America/Manaus');
    expect(await new PrismaClinicTimeZoneReader(prismaFor(saoPaulo.tenantId)).current()).toBe('America/Sao_Paulo');
  });

  it('valor gravado que não é um fuso conhecido é erro — nunca vira o padrão em silêncio', async () => {
    await setTimeZone(manaus, 'Brasilia'); // restaurado no `finally`
    try {
      await expect(new PrismaClinicTimeZoneReader(prismaFor(manaus.tenantId)).current()).rejects.toThrow(/Fuso horário inválido: "Brasilia"/);
      await expect(new PrismaClinicRepository(prismaFor(manaus.tenantId)).findByTenantId(manaus.tenantId)).rejects.toThrow(/Fuso horário inválido/);
      // A outra clínica não é afetada.
      expect(await new PrismaClinicTimeZoneReader(prismaFor(saoPaulo.tenantId)).current()).toBe('America/Sao_Paulo');
    } finally {
      await setTimeZone(manaus, 'America/Manaus');
    }
  });

  it('a Clínica expõe o fuso, e salvar as outras configurações não o altera', async () => {
    const repository = new PrismaClinicRepository(prismaFor(manaus.tenantId));
    const clinic = await repository.findByTenantId(manaus.tenantId);
    expect(clinic?.timeZone).toBe('America/Manaus');

    clinic?.updatePolicies({ defaultSessionDurationMinutes: 45 });
    await repository.save(clinic as NonNullable<typeof clinic>);

    const stored = await fixturePrisma.clinicSettings.findUniqueOrThrow({ where: { tenantId: manaus.tenantId } });
    expect(stored.defaultSessionDurationMinutes).toBe(45);
    expect(stored.timeZone).toBe('America/Manaus');
  });

  it('o calendário de disponibilidade vem do repositório com o fuso da clínica dele', async () => {
    const ofSaoPaulo = await new PrismaAvailabilityRepository(prismaFor(saoPaulo.tenantId)).findByTherapistId(saoPaulo.therapistId);
    const ofManaus = await new PrismaAvailabilityRepository(prismaFor(manaus.tenantId)).findByTherapistId(manaus.therapistId);
    const withoutSettings = await new PrismaAvailabilityRepository(prismaFor(noSettings.tenantId)).findByTherapistId(noSettings.therapistId);

    expect(ofSaoPaulo?.timeZone).toBe('America/Sao_Paulo');
    expect(ofManaus?.timeZone).toBe('America/Manaus');
    expect(withoutSettings?.timeZone).toBe('America/Sao_Paulo');
  });
});

describe('[AD-039] contagem de cobranças em atraso no banco, pelo dia da clínica', () => {
  // Vencimentos em volta de 10/08/2031, como a API os grava (meia-noite UTC do dia).
  const LAST_INSTANT_OF_THE_10TH_SP = new Date('2031-08-11T02:59:59.999Z'); // 23:59:59,999 de 10/08 em São Paulo
  const FIRST_INSTANT_OF_THE_11TH_SP = new Date('2031-08-11T03:00:00.000Z'); // 00:00 de 11/08 em São Paulo
  const OLD_CUTOFF = new Date('2031-08-11T00:00:00.000Z'); // 21:00 de 10/08 em São Paulo — o corte antigo

  beforeAll(async () => {
    for (const fixture of [saoPaulo, manaus]) {
      await createBilling(fixture, '2031-08-09', 'pendente');
      await createBilling(fixture, '2031-08-10', 'enviada');
      await createBilling(fixture, '2031-08-11', 'criada');
      await createBilling(fixture, '2031-08-01', 'quitada'); // paga: nunca conta
      await createBilling(fixture, '2031-08-01', 'cancelada');
      await createBilling(fixture, '2031-12-01', 'atrasada'); // conta pelo estado, com qualquer vencimento
    }
  });

  const countIn = (fixture: DedicatedFixture, timeZone: string, reference: Date) =>
    new PrismaBillingRepository(prismaFor(fixture.tenantId)).countOverdueByTenant(timeZone, reference);

  it('no último instante do dia do vencimento, a cobrança que vence nesse dia ainda não conta', async () => {
    // Contam: a `atrasada` e a que venceu no dia 9.
    expect(await countIn(saoPaulo, 'America/Sao_Paulo', LAST_INSTANT_OF_THE_10TH_SP)).toBe(2);
  });

  it('à meia-noite do dia seguinte, no fuso da clínica, ela passa a contar', async () => {
    expect(await countIn(saoPaulo, 'America/Sao_Paulo', FIRST_INSTANT_OF_THE_11TH_SP)).toBe(3);
  });

  it('no corte antigo (meia-noite UTC, 21h de Brasília do dia do vencimento) ela ainda não conta', async () => {
    expect(await countIn(saoPaulo, 'America/Sao_Paulo', OLD_CUTOFF)).toBe(2);
  });

  it('no mesmo instante, a clínica de Manaus ainda está no dia do vencimento', async () => {
    const instant = new Date('2031-08-11T03:30:00.000Z'); // 00:30 de 11/08 em São Paulo; 23:30 de 10/08 em Manaus

    expect(await countIn(saoPaulo, 'America/Sao_Paulo', instant)).toBe(3);
    expect(await countIn(manaus, 'America/Manaus', instant)).toBe(2);
    expect(await countIn(manaus, 'America/Manaus', new Date('2031-08-11T04:00:00.000Z'))).toBe(3); // 00:00 de 11/08 em Manaus
  });

  it('o filtro do banco e Billing.isOverdue() dão a mesma resposta, instante por instante e fuso por fuso', async () => {
    const references = [
      OLD_CUTOFF,
      LAST_INSTANT_OF_THE_10TH_SP,
      FIRST_INSTANT_OF_THE_11TH_SP,
      new Date('2031-08-10T02:59:59.999Z'),
      new Date('2031-08-10T03:00:00.000Z'),
      new Date('2031-08-10T14:59:59.999Z'),
      new Date('2031-08-10T15:00:00.000Z'),
      new Date('2031-08-12T03:00:00.000Z'),
      new Date('2031-08-09T12:00:00.000Z'),
    ];
    const repository = new PrismaBillingRepository(prismaFor(saoPaulo.tenantId));
    const billings = await repository.findAllByTenant({ limit: 100 });
    expect(billings).toHaveLength(6);

    for (const timeZone of ['America/Sao_Paulo', 'America/Manaus', 'UTC', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
      for (const reference of references) {
        const byEntity = billings.filter((billing) => billing.isOverdue(timeZone, reference)).length;
        expect(await repository.countOverdueByTenant(timeZone, reference), `${timeZone} em ${reference.toISOString()}`).toBe(byEntity);
      }
    }
  });

  it('a contagem de uma clínica não enxerga as cobranças da outra', async () => {
    const farFuture = new Date('2032-01-01T12:00:00.000Z');

    // Em cada clínica: 3 por vencimento + 1 `atrasada` = 4 (as 2 encerradas nunca contam). Nunca 8.
    expect(await countIn(saoPaulo, 'America/Sao_Paulo', farFuture)).toBe(4);
    expect(await countIn(manaus, 'America/Manaus', farFuture)).toBe(4);
  });
});
