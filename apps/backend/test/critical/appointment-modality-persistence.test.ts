import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaAppointmentRepository } from '@infrastructure/database/repositories/prisma-appointment.repository';
import { Appointment } from '@domain/appointment/appointment.entity';
import { TenantContext } from '@shared/tenant-context';
import { uniqueSlot } from './support/unique-slot';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * AD-004 (AUDITORIA_TECNICA_DEFINITIVA.md, seção 3.3) — regressão do bug
 * confirmado: PrismaAppointmentRepository.upsertAll() nunca gravava
 * `modality`, então todo Appointment criado como 'online' era persistido
 * silenciosamente como 'presencial' (default da coluna). Causa raiz real:
 * Appointment.entity.ts não expunha `modality` via getter público — sem
 * isso, o Repository nem conseguiria referenciar appointment.modality.
 *
 * Mesmo padrão de test/critical/appointment-savemany-transactional.test.ts
 * (A1): Repository puro, fixture dedicada, sem HTTP/Use Case/Motor.
 */

let client: PrismaClientProvider;
let fixturePrisma: PrismaClient;
let fixture: DedicatedFixture;

function tenantContext() {
  const tc = new TenantContext();
  tc.set(fixture.tenantId, 'admin-dedicated');
  return tc;
}

function repoFor(tc: TenantContext) {
  const prismaService = new PrismaService(client, tc);
  return new PrismaAppointmentRepository(prismaService);
}

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

beforeAll(async () => {
  client = new PrismaClientProvider();
  await client.$connect();

  fixturePrisma = new PrismaClient({
    datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } },
  });
  await fixturePrisma.$connect();

  fixture = await createDedicatedFixture(fixturePrisma, 'AD004');
});

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await client.$disconnect();
  await fixturePrisma.$disconnect();
});

describe('PrismaAppointmentRepository — persistência de modality (AD-004)', () => {
  it('persiste modality "online" — não regride para o default "presencial" da coluna', async () => {
    const repo = repoFor(tenantContext());
    const appointment = Appointment.create({
      id: randomUUID(),
      tenantId: fixture.tenantId,
      patientId: fixture.patientId,
      therapistId: fixture.therapistId,
      scheduledAt: new Date(uniqueSlot()),
      modality: 'online',
      recurring: false,
    });

    await repo.save(appointment);
    fixture.appointmentIds.push(appointment.id);

    const found = await repo.findById(appointment.id);
    expect(found).not.toBeNull();
    expect(found?.modality).toBe('online');
  });

  it('persiste modality "presencial" quando explicitamente escolhida', async () => {
    const repo = repoFor(tenantContext());
    const appointment = Appointment.create({
      id: randomUUID(),
      tenantId: fixture.tenantId,
      patientId: fixture.patientId,
      therapistId: fixture.therapistId,
      scheduledAt: new Date(uniqueSlot()),
      modality: 'presencial',
      recurring: false,
    });

    await repo.save(appointment);
    fixture.appointmentIds.push(appointment.id);

    const found = await repo.findById(appointment.id);
    expect(found?.modality).toBe('presencial');
  });

  it('mantém modality ao atualizar (transitionTo aciona o branch update do upsert)', async () => {
    const repo = repoFor(tenantContext());
    const appointment = Appointment.create({
      id: randomUUID(),
      tenantId: fixture.tenantId,
      patientId: fixture.patientId,
      therapistId: fixture.therapistId,
      scheduledAt: new Date(uniqueSlot()),
      modality: 'online',
      recurring: false,
    });
    await repo.save(appointment);
    fixture.appointmentIds.push(appointment.id);

    appointment.transitionTo('Reservada');
    await repo.save(appointment);

    const found = await repo.findById(appointment.id);
    expect(found?.modality).toBe('online');
    expect(found?.state).toBe('Reservada');
  });
});
