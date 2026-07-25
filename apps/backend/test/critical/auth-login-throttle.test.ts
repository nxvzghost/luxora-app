import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, UserRole } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { AuthService } from '@api/auth/auth.service';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * AD-006 — rate limit real de POST /auth/login (@nestjs/throttler).
 *
 * Sobrescreve AUTH_THROTTLE_LIMIT/AUTH_THROTTLE_TTL_MS para um valor
 * pequeno e controlado ANTES de bootstrapTestApp() — só para este arquivo,
 * cujo app próprio lê essas variáveis no momento em que o AuthModule é
 * construído. O resto da Suíte Crítica usa o valor alto definido em
 * test/critical/support/global-setup.ts (senão os ~18 arquivos que fazem
 * login real quebrariam aqui). Valores originais restaurados no afterAll.
 *
 * Não usa loginAs()/createDedicatedUserAndLogin() para o setup — ambos já
 * fazem 1 POST /auth/login internamente, o que consumiria parte do
 * orçamento de tentativas que este teste precisa controlar com precisão.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let fixture: DedicatedFixture;
let originalLimit: string | undefined;
let originalTtlMs: string | undefined;

const TEST_LIMIT = 3;
// 10s, não um valor mais curto: precisa sobreviver com folga ao tempo real
// entre os 3 blocos it() deste arquivo (setup de hooks, agendamento do
// Vitest) — um TTL de 1500ms já se mostrou curto demais na prática (a
// tentativa N+1 chegou depois da janela já ter expirado, sem 429 nenhum).
const TEST_TTL_MS = 10000;
const TEST_EMAIL = `throttle-test-${Date.now()}@luxora.dev`;
const TEST_PASSWORD = 'senha-de-teste-2026-throttle';

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

beforeAll(async () => {
  originalLimit = process.env.AUTH_THROTTLE_LIMIT;
  originalTtlMs = process.env.AUTH_THROTTLE_TTL_MS;
  process.env.AUTH_THROTTLE_LIMIT = String(TEST_LIMIT);
  process.env.AUTH_THROTTLE_TTL_MS = String(TEST_TTL_MS);

  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();

  // bootstrapTestApp() lê AUTH_THROTTLE_LIMIT/_TTL_MS agora, com os valores
  // de teste já sobrescritos acima.
  app = await bootstrapTestApp();

  fixture = await createDedicatedFixture(fixturePrisma, 'AUTHTHROTTLE');
  const user = await fixturePrisma.user.create({
    data: {
      tenantId: fixture.tenantId,
      email: TEST_EMAIL,
      passwordHash: await AuthService.hashPassword(TEST_PASSWORD),
      role: UserRole.admin,
    },
  });
  fixture.userIds.push(user.id);
});

afterAll(async () => {
  process.env.AUTH_THROTTLE_LIMIT = originalLimit;
  process.env.AUTH_THROTTLE_TTL_MS = originalTtlMs;
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await fixturePrisma.$disconnect();
  await app?.close();
});

describe('[AD-006] Rate limit de POST /auth/login', () => {
  it(`as primeiras ${TEST_LIMIT} tentativas não são bloqueadas pelo throttle — credencial errada ainda produz 401 real, nunca 429`, async () => {
    for (let attempt = 0; attempt < TEST_LIMIT; attempt++) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: TEST_EMAIL, password: 'senha-errada-de-proposito' });
      expect(res.status).toBe(401);
    }
  });

  it(`a tentativa ${TEST_LIMIT + 1} é bloqueada com 429, no formato oficial de erro da API — mesmo com a senha certa`, async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(res.body.error.category).toBe('rate_limit');
  });

  it(
    'passado o TTL, uma nova tentativa é aceita novamente — login real com a senha certa funciona',
    async () => {
      await new Promise((resolve) => setTimeout(resolve, TEST_TTL_MS + 500));

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
      expect(res.status).toBe(200);
      expect(typeof res.body.accessToken).toBe('string');
    },
    TEST_TTL_MS + 5000, // testTimeout explícito — default (5000ms) é menor que o sleep proposital acima.
  );
});
