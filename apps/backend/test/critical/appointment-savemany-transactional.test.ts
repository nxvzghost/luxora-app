import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaAppointmentRepository } from '@infrastructure/database/repositories/prisma-appointment.repository';
import { Appointment } from '@domain/appointment/appointment.entity';
import { TenantContext } from '@shared/tenant-context';
import { uniqueSlot } from './support/unique-slot';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * PD-001 Fase 2, item A1 — saveMany transacional (AppointmentRepository).
 *
 * Não é um dos 16 Testes Críticos documentados em docs/09-Testes/ — é a
 * prova de um novo primitivo de infraestrutura, testado diretamente contra
 * o Repository (sem passar por HTTP/Use Case/Motor de Disponibilidade) —
 * por isso não precisa de AvailabilityCalendar nem de assinatura ativa
 * (nunca passa por VerificarDisponibilidadeUseCase nem SubscriptionAccessGuard).
 *
 * Infraestrutura de teste (Etapa 1 da correção de estabilidade da Suíte
 * Crítica): Tenant/Terapeuta/Paciente dedicados, não mais o Tenant A
 * seedado compartilhado — elimina o acúmulo indefinido de Appointment.
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
  return { repo: new PrismaAppointmentRepository(prismaService), prismaService };
}

function newAppointment(scheduledAt: Date) {
  const appointment = Appointment.create({
    id: randomUUID(),
    tenantId: fixture.tenantId,
    patientId: fixture.patientId,
    therapistId: fixture.therapistId,
    scheduledAt,
    modality: 'presencial',
    recurring: true,
  });
  appointment.transitionTo('Reservada');
  return appointment;
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

  fixture = await createDedicatedFixture(fixturePrisma, 'A1');
});

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await client.$disconnect();
  await fixturePrisma.$disconnect();
});

describe('PrismaAppointmentRepository.saveMany — atomicidade (A1)', () => {
  it('salva N Appointments de um lote sem conflito — todos persistidos', async () => {
    const { repo } = repoFor(tenantContext());
    const base = new Date(uniqueSlot());
    const batch = [
      newAppointment(base),
      newAppointment(new Date(base.getTime() + 2 * 60 * 60 * 1000)),
      newAppointment(new Date(base.getTime() + 4 * 60 * 60 * 1000)),
    ];

    await repo.saveMany(batch);
    fixture.appointmentIds.push(...batch.map((a) => a.id));

    for (const appointment of batch) {
      const found = await repo.findById(appointment.id);
      expect(found).not.toBeNull();
    }
  });

  it('reverte o lote inteiro quando uma ocorrência no meio colide (SESSION_CONFLICT) — nenhuma fica órfã', async () => {
    const { repo } = repoFor(tenantContext());
    const conflictingSlot = new Date(uniqueSlot());

    // Ocupa o horário ANTES do lote, simulando uma corrida concorrente que já commitou.
    const existing = newAppointment(conflictingSlot);
    await repo.save(existing);
    fixture.appointmentIds.push(existing.id);

    const first = newAppointment(new Date(conflictingSlot.getTime() + 2 * 60 * 60 * 1000));
    const second = newAppointment(new Date(conflictingSlot.getTime() + 4 * 60 * 60 * 1000));
    const conflicting = newAppointment(conflictingSlot); // mesmo terapeuta/horário do `existing` — colide

    let caught: unknown;
    try {
      await repo.saveMany([first, second, conflicting]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).getResponse()).toMatchObject({ code: 'SESSION_CONFLICT' });

    // As duas primeiras, que individualmente teriam sido aceitas, NÃO
    // podem ter ficado persistidas — é exatamente a garantia que A1 existe
    // para dar (lote é tudo ou nada, não "as que deram tempo antes da que
    // falhou"). Nada a limpar para elas — nunca persistiram.
    expect(await repo.findById(first.id)).toBeNull();
    expect(await repo.findById(second.id)).toBeNull();
  });

  it('compõe com uma transação já aberta pelo chamador (tx externo) — não abre a própria', async () => {
    const tc = tenantContext();
    const { repo, prismaService } = repoFor(tc);
    const base = new Date(uniqueSlot());
    const a1 = newAppointment(base);
    const a2 = newAppointment(new Date(base.getTime() + 2 * 60 * 60 * 1000));

    // Chama saveMany DENTRO da transação do chamador e força a transação
    // inteira a falhar depois — se saveMany tivesse aberto (e commitado) a
    // própria transação, a1/a2 sobreviveriam. Se de fato compôs com o `tx`
    // externo, revertem junto com o resto. Nada a limpar — nunca persistem.
    await expect(
      prismaService.forTenant(async (tx) => {
        await repo.saveMany([a1, a2], tx);
        throw new Error('falha deliberada depois do saveMany, ainda dentro da mesma transação');
      }),
    ).rejects.toThrow('falha deliberada');

    expect(await repo.findById(a1.id)).toBeNull();
    expect(await repo.findById(a2.id)).toBeNull();
  });

  it('save() continua com o mesmo comportamento público de sempre (delega para saveMany internamente)', async () => {
    const { repo } = repoFor(tenantContext());
    const appointment = newAppointment(new Date(uniqueSlot()));

    await repo.save(appointment);
    fixture.appointmentIds.push(appointment.id);

    const found = await repo.findById(appointment.id);
    expect(found).not.toBeNull();
    expect(found?.state).toBe('Reservada');
  });
});
