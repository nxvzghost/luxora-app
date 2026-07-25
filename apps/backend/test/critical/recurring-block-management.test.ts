import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaRecurringBlockRepository } from '@infrastructure/database/repositories/prisma-recurring-block.repository';
import { PrismaAuditLogRepository } from '@infrastructure/database/repositories/prisma-audit-log.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { CriarRecurringBlockUseCase, ListarRecurringBlocksUseCase } from '@use-cases/availability/gerenciar-recurring-block.use-case';
import { TenantContext } from '@shared/tenant-context';

/**
 * PD-001 Fase 2, C4.1 — CriarRecurringBlockUseCase de ponta a ponta
 * (Repository real, AuditService real, banco real). Usa Tenant/Therapist/
 * Patient dedicados, criados e destruídos nesta própria execução — mesma
 * lição aplicada na revisão de estabilidade da C3 (não reusar dado seedado
 * compartilhado com outros arquivos de teste crítico, para nunca depender
 * de findFirst()/ordem/estado incidental).
 */

let client: PrismaClientProvider;
let tenantId: string;
let patientId: string;
let therapistId: string;
let secondTherapistId: string; // mesmo Tenant, para provar filtro por terapeuta na listagem
let otherTenantId: string; // Tenant dedicado separado, para provar isolamento entre tenants na listagem

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}
const fixturePrisma = new PrismaClient({
  datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } },
});

beforeAll(async () => {
  client = new PrismaClientProvider();
  await client.$connect();
  await fixturePrisma.$connect();

  const dedicatedTenant = await fixturePrisma.tenant.create({
    data: { name: `Tenant Dedicado — C4.1 RecurringBlock ${randomUUID()}` },
  });
  tenantId = dedicatedTenant.id;

  const dedicatedTherapist = await fixturePrisma.therapist.create({
    data: { tenantId, name: `Terapeuta Dedicado — C4.1 ${randomUUID()}`, specialty: 'Psicologia' },
  });
  therapistId = dedicatedTherapist.id;

  const dedicatedPatient = await fixturePrisma.patient.create({
    data: { tenantId, name: `Paciente Dedicado — C4.1 ${randomUUID()}`, phone: '11999999999' },
  });
  patientId = dedicatedPatient.id;

  const secondTherapist = await fixturePrisma.therapist.create({
    data: { tenantId, name: `Terapeuta Dedicado 2 — C4.2 ${randomUUID()}`, specialty: 'Psicologia' },
  });
  secondTherapistId = secondTherapist.id;

  const otherTenant = await fixturePrisma.tenant.create({
    data: { name: `Tenant Dedicado B — C4.2 RecurringBlock ${randomUUID()}` },
  });
  otherTenantId = otherTenant.id;
});

afterAll(async () => {
  await fixturePrisma.auditLog.deleteMany({ where: { tenantId } });
  await fixturePrisma.recurringBlock.deleteMany({ where: { therapistId } });
  await fixturePrisma.recurringBlock.deleteMany({ where: { therapistId: secondTherapistId } });
  await fixturePrisma.therapist.delete({ where: { id: therapistId } });
  await fixturePrisma.therapist.delete({ where: { id: secondTherapistId } });
  await fixturePrisma.patient.delete({ where: { id: patientId } });
  await fixturePrisma.tenant.delete({ where: { id: tenantId } });
  await fixturePrisma.tenant.delete({ where: { id: otherTenantId } });

  await client.$disconnect();
  await fixturePrisma.$disconnect();
});

function buildUseCase() {
  const tenantContext = new TenantContext();
  tenantContext.set(tenantId, 'user-1');
  const prismaService = new PrismaService(client, tenantContext);
  const recurringBlockRepo = new PrismaRecurringBlockRepository(client);
  const auditLogRepo = new PrismaAuditLogRepository(prismaService);
  const auditService = new AuditService(auditLogRepo, tenantContext);
  const useCase = new CriarRecurringBlockUseCase(recurringBlockRepo, tenantContext, auditService);
  return { useCase, recurringBlockRepo };
}

function buildListarUseCase(asTenantId: string) {
  const tenantContext = new TenantContext();
  tenantContext.set(asTenantId, 'user-1');
  const recurringBlockRepo = new PrismaRecurringBlockRepository(client);
  return new ListarRecurringBlocksUseCase(recurringBlockRepo, tenantContext);
}

describe('CriarRecurringBlockUseCase — ponta a ponta (C4.1)', () => {
  it('cria e persiste o bloco — round-trip via findById()', async () => {
    const { useCase, recurringBlockRepo } = buildUseCase();

    const created = await useCase.execute({
      patientId,
      therapistId,
      firstOccurrence: new Date('2026-09-01T14:00:00'),
      intervalDays: 7,
      modality: 'presencial',
      renewalMode: 'automatic',
    });

    const found = await recurringBlockRepo.findById(tenantId, created.id);
    expect(found?.id).toBe(created.id);
    expect(found?.patientId).toBe(patientId);
    expect(found?.therapistId).toBe(therapistId);
    expect(found?.intervalDays).toBe(7);
    expect(found?.modality).toBe('presencial');
    expect(found?.renewalMode).toBe('automatic');
  });

  it('grava exatamente 1 linha em audit_log, com a ação e o entityId corretos', async () => {
    const { useCase } = buildUseCase();

    const created = await useCase.execute({
      patientId,
      therapistId,
      firstOccurrence: new Date('2026-09-08T14:00:00'),
      intervalDays: 14,
      modality: 'online',
      renewalMode: 'manual',
    });

    const auditRows = await fixturePrisma.auditLog.findMany({ where: { entityId: created.id } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe('BlocoRecorrenteCriado');
    expect(auditRows[0].entityType).toBe('RecurringBlockCreated'); // event.constructor.name.replace('Event', '') — ver AuditService
    expect(auditRows[0].tenantId).toBe(tenantId);
  });
});

describe('ListarRecurringBlocksUseCase — ponta a ponta (C4.2)', () => {
  it('lista somente os blocos do terapeuta informado, mesmo havendo outro terapeuta com blocos no mesmo tenant', async () => {
    const { useCase: criar } = buildUseCase();
    const b1 = await criar.execute({
      patientId,
      therapistId,
      firstOccurrence: new Date('2026-10-01T14:00:00'),
      intervalDays: 7,
      modality: 'presencial',
      renewalMode: 'automatic',
    });
    const b2 = await criar.execute({
      patientId,
      therapistId,
      firstOccurrence: new Date('2026-10-08T14:00:00'),
      intervalDays: 7,
      modality: 'presencial',
      renewalMode: 'automatic',
    });
    // Bloco de outro terapeuta, mesmo Tenant — não deve aparecer na listagem de `therapistId`.
    await criar.execute({
      patientId,
      therapistId: secondTherapistId,
      firstOccurrence: new Date('2026-10-01T14:00:00'),
      intervalDays: 7,
      modality: 'presencial',
      renewalMode: 'automatic',
    });

    const listar = buildListarUseCase(tenantId);
    const result = await listar.execute(therapistId);

    const resultIds = result.map((b) => b.id);
    expect(resultIds).toContain(b1.id);
    expect(resultIds).toContain(b2.id);
    expect(result.every((b) => b.therapistId === therapistId)).toBe(true);
  });

  it('isolamento entre tenants: nunca retorna bloco de outro tenant', async () => {
    const { useCase: criar } = buildUseCase();
    const created = await criar.execute({
      patientId,
      therapistId,
      firstOccurrence: new Date('2026-11-01T14:00:00'),
      intervalDays: 7,
      modality: 'presencial',
      renewalMode: 'automatic',
    });

    // Tenant B consultando o mesmo therapistId (que pertence ao Tenant A) —
    // RLS + filtro explícito de tenantId devem garantir lista vazia, nunca
    // o bloco criado acima.
    const listarComoOutroTenant = buildListarUseCase(otherTenantId);
    const resultAsOtherTenant = await listarComoOutroTenant.execute(therapistId);
    expect(resultAsOtherTenant).toHaveLength(0);

    const listarComoTenantCorreto = buildListarUseCase(tenantId);
    const resultAsCorrectTenant = await listarComoTenantCorreto.execute(therapistId);
    expect(resultAsCorrectTenant.map((b) => b.id)).toContain(created.id);
  });
});
