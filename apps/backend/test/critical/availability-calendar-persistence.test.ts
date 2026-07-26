import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, UserRole } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';
import { AuthService } from '@api/auth/auth.service';
import { PrismaAvailabilityRepository } from '@infrastructure/database/repositories/prisma-availability.repository';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { TenantContext } from '@shared/tenant-context';

/**
 * AD-008 — Persistência de AvailabilityException (Epic 7).
 *
 * Prova, contra Postgres real, que uma exceção definida via
 * PUT /therapists/:id/availability/exceptions sobrevive a uma nova leitura
 * (nunca depende de estado em memória do processo) e que o Motor de
 * Disponibilidade (GET /therapists/:id/availability, slots gerados)
 * realmente para de oferecer o horário bloqueado — não só que o dado bate
 * na volta (round-trip do JSON), mas que ele tem efeito real na decisão do
 * Motor. Antes desta AD, a coluna não existia; toda exceção era descartada
 * na primeira releitura do Aggregate.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let fixture: DedicatedFixture;
let token: string;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  app = await bootstrapTestApp();
  fixture = await createDedicatedFixture(fixturePrisma, 'AD008AVAIL', { withActiveSubscription: true });

  const email = `ad008-avail-${Date.now()}@luxora.dev`;
  const password = 'senha-de-teste-2026-ad008';
  const user = await fixturePrisma.user.create({
    data: {
      tenantId: fixture.tenantId,
      email,
      passwordHash: await AuthService.hashPassword(password),
      role: UserRole.admin,
    },
  });
  fixture.userIds.push(user.id);

  const loginRes = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
  expect(loginRes.status).toBe(200);
  token = loginRes.body.accessToken as string;

  // Janela ampla o suficiente para cobrir a data de teste, qualquer que seja o dia da semana.
  const windowsRes = await request(app.getHttpServer())
    .put(`/api/v1/therapists/${fixture.therapistId}/availability`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      windows: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        dayOfWeek,
        startTime: '08:00',
        endTime: '18:00',
        sessionDurationMinutes: 60,
      })),
    });
  expect(windowsRes.status).toBe(200);
});

afterAll(async () => {
  await fixturePrisma.availabilityCalendar.deleteMany({ where: { therapistId: fixture.therapistId } });
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await fixturePrisma.$disconnect();
  await app?.close();
});

describe('[AD-008] PUT /therapists/:id/availability/exceptions — persistência real', () => {
  it('grava a exceção e a devolve na resposta (round-trip imediato)', async () => {
    const res = await request(app.getHttpServer())
      .put(`/api/v1/therapists/${fixture.therapistId}/availability/exceptions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ exceptions: [{ from: '2026-08-03T09:00:00.000Z', to: '2026-08-03T12:00:00.000Z', reason: 'Férias' }] });

    expect(res.status).toBe(200);
    expect(res.body.exceptions).toHaveLength(1);
    expect(res.body.exceptions[0].reason).toBe('Férias');
  });

  it('sobrevive a uma nova instância do repositório — nunca depende de estado em memória do processo', async () => {
    // Cliente Prisma, PrismaService e Repository novos, sem nenhuma
    // referência compartilhada com o app HTTP acima. Se a exceção só
    // existisse em memória (o bug que esta AD corrige), este repositório
    // nunca a veria.
    const freshClient = new PrismaClientProvider();
    await freshClient.$connect();
    const tenantContext = new TenantContext();
    tenantContext.set(fixture.tenantId, null);
    const prismaService = new PrismaService(freshClient, tenantContext);
    const freshRepo = new PrismaAvailabilityRepository(prismaService);

    try {
      const calendar = await freshRepo.findByTherapistId(fixture.therapistId);
      expect(calendar).not.toBeNull();
      expect(calendar!.exceptions).toHaveLength(1);
      expect(calendar!.exceptions[0].from).toBeInstanceOf(Date);
      expect(calendar!.exceptions[0].from.toISOString()).toBe('2026-08-03T09:00:00.000Z');
      expect(calendar!.exceptions[0].to.toISOString()).toBe('2026-08-03T12:00:00.000Z');
    } finally {
      await freshClient.$disconnect();
    }
  });

  it('o Motor de Disponibilidade real (GET /therapists/:id/availability) para de oferecer o horário bloqueado pela exceção persistida', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/therapists/${fixture.therapistId}/availability`)
      .query({ from: '2026-08-03T00:00:00.000Z', to: '2026-08-03T23:59:59.000Z' })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const slots = res.body.data as Array<{ startsAt: string }>;
    expect(slots.length).toBeGreaterThan(0);
    const blockedSlotStillOffered = slots.some((slot) => {
      const start = new Date(slot.startsAt);
      return start >= new Date('2026-08-03T09:00:00.000Z') && start < new Date('2026-08-03T12:00:00.000Z');
    });
    expect(blockedSlotStillOffered).toBe(false);

    // Controle: um horário fora da exceção, no mesmo dia, continua livre —
    // prova que a exceção bloqueia só o intervalo dela, não o dia inteiro.
    const slotOutsideException = slots.some((slot) => {
      const start = new Date(slot.startsAt);
      return start >= new Date('2026-08-03T14:00:00.000Z') && start < new Date('2026-08-03T15:00:00.000Z');
    });
    expect(slotOutsideException).toBe(true);
  });

  it('substitui a exceção inteira (nunca faz merge parcial) — mesma semântica de setExceptions()', async () => {
    const res = await request(app.getHttpServer())
      .put(`/api/v1/therapists/${fixture.therapistId}/availability/exceptions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ exceptions: [{ from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' }] });

    expect(res.status).toBe(200);
    expect(res.body.exceptions).toHaveLength(1);
    expect(res.body.exceptions[0].from).toBe('2026-09-01T00:00:00.000Z');
  });

  it('rejeita from >= to com erro de validação de domínio', async () => {
    const res = await request(app.getHttpServer())
      .put(`/api/v1/therapists/${fixture.therapistId}/availability/exceptions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ exceptions: [{ from: '2026-08-10T00:00:00.000Z', to: '2026-08-03T00:00:00.000Z' }] });

    expect(res.status).toBe(500);
  });

  it('exige autenticação — sem token, 401 (mesmo Guard da rota irmã de janelas)', async () => {
    const res = await request(app.getHttpServer())
      .put(`/api/v1/therapists/${fixture.therapistId}/availability/exceptions`)
      .send({ exceptions: [] });

    expect(res.status).toBe(401);
  });
});
