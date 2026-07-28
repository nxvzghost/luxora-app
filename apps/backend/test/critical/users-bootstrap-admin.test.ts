import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * AD-001 — POST /users/bootstrap-admin (Opção A, endpoint público condicional).
 *
 * `createDedicatedFixture()` sozinho (sem `createDedicatedUserAndLogin()`)
 * cria Tenant + Therapist + Patient, mas ZERO `User` — exatamente o cenário
 * que este endpoint existe para resolver. Cada teste que efetivamente
 * provisiona um admin usa seu PRÓPRIO Tenant dedicado (nunca compartilha
 * `fixture` entre si) — evita qualquer dependência de ordem de execução
 * entre testes deste arquivo.
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

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  app = await bootstrapTestApp();
  fixture = await createDedicatedFixture(fixturePrisma, 'AD001BOOT');
});

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await fixturePrisma.$disconnect();
  await app?.close();
});

describe('[AD-001] POST /users/bootstrap-admin', () => {
  it('rejeita Tenant inexistente com 404', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/users/bootstrap-admin')
      .send({ tenantId: '00000000-0000-4000-8000-000000000000', email: 'admin@fantasma.dev', password: 'senha-forte-123' });
    expect(res.status).toBe(404);
  });

  it('rejeita senha curta com 400 (nunca chega a tocar o banco)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/users/bootstrap-admin')
      .send({ tenantId: fixture.tenantId, email: 'curto@clinica.dev', password: '123' });
    expect(res.status).toBe(400);

    const userCount = await fixturePrisma.user.count({ where: { tenantId: fixture.tenantId } });
    expect(userCount).toBe(0);
  });

  it('provisiona o primeiro admin, devolve tokens válidos, e o admin já consegue logar de verdade em seguida', async () => {
    // withActiveSubscription: true — o token emitido no bootstrap é usado a
    // seguir para acessar GET /users, que passa por SubscriptionAccessGuard;
    // sem assinatura ativa no Tenant dedicado, essa chamada retornaria 403
    // (achado real: falha não é do fluxo de bootstrap, é da fixture do teste).
    const dedicated = await createDedicatedFixture(fixturePrisma, 'AD001BOOTOK', { withActiveSubscription: true });
    try {
      const email = `admin-bootstrap-${Date.now()}@clinica.dev`;
      const password = 'senha-forte-de-bootstrap-2026';

      const res = await request(app.getHttpServer())
        .post('/api/v1/users/bootstrap-admin')
        .send({ tenantId: dedicated.tenantId, email, password });

      expect(res.status).toBe(201);
      expect(typeof res.body.accessToken).toBe('string');
      expect(typeof res.body.refreshToken).toBe('string');

      // Prova que o token emitido no bootstrap é real e funcional — não só
      // uma string qualquer — usando-o para acessar uma rota protegida.
      const listRes = await request(app.getHttpServer())
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${res.body.accessToken}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.data).toHaveLength(1);
      expect(listRes.body.data[0].role).toBe('admin');
      expect(listRes.body.data[0].passwordHash).toBeUndefined();

      // Prova que o admin também consegue logar via /auth/login normalmente
      // depois (a senha foi de fato cifrada com AuthService.hashPassword()).
      const loginRes = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
      expect(loginRes.status).toBe(200);
    } finally {
      // O admin foi criado via chamada HTTP real, não via createDedicatedUserAndLogin()
      // — nunca entra em fixture.userIds. Sem esta limpeza explícita,
      // cleanupDedicatedFixture() violaria a FK user->tenant ao tentar
      // apagar o Tenant (mesma classe de achado já registrada para
      // AvailabilityCalendar/Session em ADs anteriores).
      await fixturePrisma.user.deleteMany({ where: { tenantId: dedicated.tenantId } });
      await cleanupDedicatedFixture(fixturePrisma, dedicated);
    }
  });

  it('bloqueia permanentemente uma segunda tentativa para o mesmo Tenant — 409, nunca cria um segundo admin', async () => {
    const dedicated = await createDedicatedFixture(fixturePrisma, 'AD001BOOT409');
    try {
      const first = await request(app.getHttpServer())
        .post('/api/v1/users/bootstrap-admin')
        .send({ tenantId: dedicated.tenantId, email: `primeiro-${Date.now()}@clinica.dev`, password: 'senha-forte-123456' });
      expect(first.status).toBe(201);

      const second = await request(app.getHttpServer())
        .post('/api/v1/users/bootstrap-admin')
        .send({ tenantId: dedicated.tenantId, email: `segundo-${Date.now()}@clinica.dev`, password: 'senha-forte-123456' });
      expect(second.status).toBe(409);

      const userCount = await fixturePrisma.user.count({ where: { tenantId: dedicated.tenantId } });
      expect(userCount).toBe(1);
    } finally {
      await fixturePrisma.user.deleteMany({ where: { tenantId: dedicated.tenantId } });
      await cleanupDedicatedFixture(fixturePrisma, dedicated);
    }
  });

  it('sob concorrência real (2 chamadas simultâneas para o mesmo Tenant), exatamente 1 sucesso e 1 rejeição — nunca 2 admins', async () => {
    const dedicated = await createDedicatedFixture(fixturePrisma, 'AD001RACE');
    try {
      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/users/bootstrap-admin')
          .send({ tenantId: dedicated.tenantId, email: `race-a-${Date.now()}@clinica.dev`, password: 'senha-forte-123456' }),
        request(app.getHttpServer())
          .post('/api/v1/users/bootstrap-admin')
          .send({ tenantId: dedicated.tenantId, email: `race-b-${Date.now()}@clinica.dev`, password: 'senha-forte-123456' }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 409]);

      const userCount = await fixturePrisma.user.count({ where: { tenantId: dedicated.tenantId } });
      expect(userCount).toBe(1);
    } finally {
      await fixturePrisma.user.deleteMany({ where: { tenantId: dedicated.tenantId } });
      await cleanupDedicatedFixture(fixturePrisma, dedicated);
    }
  });
});
