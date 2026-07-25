import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * Sprint 2 — Application Integration. Valida o fluxo completo
 * HTTP → Controller → Use Case → Repository contra Postgres real, não
 * mocks — mesmo padrão de tenant-api-key.test.ts.
 *
 * CEO-DEC-002.5, CEO-DEC-003.6.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let fixture: DedicatedFixture;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

describe('[Sprint 2] Upgrade/Downgrade de Assinatura — integração HTTP real', () => {
  it('POST /subscription/upgrade aplica o novo plano imediatamente', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/subscription/upgrade')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ newPlan: 'business' });

    expect(res.status).toBe(201);
    expect(res.body.plan).toBe('business');

    const persisted = await fixturePrisma.clinicSubscription.findUnique({ where: { tenantId: fixture.tenantId } });
    expect(persisted?.plan).toBe('business');
  });

  it('POST /subscription/downgrade agenda pendingPlan sem trocar o plano ativo (elegível: 1 terapeuta)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/subscription/downgrade')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ newPlan: 'professional' });

    expect(res.status).toBe(201);
    expect(res.body.plan).toBe('business'); // inalterado
    expect(res.body.pendingPlan).toBe('professional'); // agendado

    const persisted = await fixturePrisma.clinicSubscription.findUnique({ where: { tenantId: fixture.tenantId } });
    expect(persisted?.plan).toBe('business');
    expect(persisted?.pendingPlan).toBe('professional');
  });

  it('rejeita upgrade/downgrade para individual/completo — DTO valida antes de chegar ao domínio', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/subscription/upgrade')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ newPlan: 'individual' });

    expect(res.status).toBe(400);
  });

  it('DowngradeAssinaturaUseCase rejeita quando terapeutas ativos excedem o teto do plano alvo (via HTTP real)', async () => {
    // Cadastra um segundo terapeuta na mesma clínica — Business/Professional
    // têm maxTherapists=1, então 2 terapeutas ativos torna qualquer
    // downgrade inelegível.
    // AD-034: registrado em fixture.therapistIds (coleção da própria
    // DedicatedFixture) — antes ficava órfão, sem nenhum rastreamento, e
    // cleanupDedicatedFixture() falhava com FK violation ao tentar apagar o
    // Tenant enquanto este terapeuta ainda existia.
    const segundoTerapeuta = await fixturePrisma.therapist.create({
      data: { tenantId: fixture.tenantId, name: 'Segundo Terapeuta — Sprint2', specialty: 'Psicologia' },
    });
    fixture.therapistIds.push(segundoTerapeuta.id);

    const res = await request(app.getHttpServer())
      .post('/api/v1/subscription/downgrade')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ newPlan: 'professional' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SUBSCRIPTION_DOWNGRADE_NOT_ELIGIBLE');
  });
});

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();

  app = await bootstrapTestApp();

  fixture = await createDedicatedFixture(fixturePrisma, 'UPGRADEDOWNGRADE', { withActiveSubscription: true });
  await createDedicatedUserAndLogin(fixturePrisma, app, fixture, 'UPGRADEDOWNGRADE');
});

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await fixturePrisma.$disconnect();
  await app.close();
});
