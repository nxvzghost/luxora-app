import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, UserRole } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';
import { AuthService } from '@api/auth/auth.service';

/**
 * AD-016 — Observabilidade de Base: Correlation ID e GET /metrics.
 *
 * Ponta a ponta contra o app real (bootstrapTestApp() — mesmos guards/pipes
 * de main.ts, ver support/bootstrap-app.ts). Não testa OpenTelemetry/
 * Prometheus em si (bibliotecas de terceiros, já testadas fora do escopo
 * desta Suíte) — testa que ESTE app os expõe corretamente: o middleware de
 * Correlation ID roda antes de qualquer Guard, e o MetricsAccessGuard
 * protege /metrics de verdade.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let fixture: DedicatedFixture;
const LOGIN_EMAIL = `ad016-obs-${Date.now()}@luxora.dev`;
const LOGIN_PASSWORD = 'senha-de-teste-2026-observabilidade';

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
  fixture = await createDedicatedFixture(fixturePrisma, 'AD016OBS', { withActiveSubscription: true });

  const user = await fixturePrisma.user.create({
    data: {
      tenantId: fixture.tenantId,
      email: LOGIN_EMAIL,
      passwordHash: await AuthService.hashPassword(LOGIN_PASSWORD),
      role: UserRole.admin,
    },
  });
  fixture.userIds.push(user.id);
});

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await fixturePrisma.$disconnect();
  await app?.close();
});

describe('[AD-016] Correlation ID ponta a ponta', () => {
  it('toda resposta (mesmo de rota autenticada) inclui X-Correlation-Id — gerado quando o cliente não envia um', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBeTruthy();
  });

  it('reaproveita o X-Correlation-Id enviado pelo cliente, em vez de gerar um novo', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('X-Correlation-Id', 'meu-id-fixo-de-teste-e2e');
    expect(res.headers['x-correlation-id']).toBe('meu-id-fixo-de-teste-e2e');
  });

  it('roda antes de qualquer Guard — até uma resposta 401 (JwtAuthGuard) tem Correlation ID', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/patients');
    expect(res.status).toBe(401);
    expect(res.headers['x-correlation-id']).toBeTruthy();
    // AD-016 — LuxoraExceptionFilter também expõe o correlationId no corpo do erro.
    expect(res.body.error.correlationId).toBe(res.headers['x-correlation-id']);
  });

  // Critério de conclusão do Epic 4 (docs/PLANO_DE_EXECUCAO.md): "Teste de
  // smoke confirmando presença do correlationId em pelo menos 3 fluxos
  // (auth, appointment, billing)".
  it('smoke: correlationId presente nos 3 fluxos do critério de conclusão do Epic 4 (auth, appointment, billing)', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD });
    expect(loginRes.status).toBe(200);
    expect(loginRes.headers['x-correlation-id']).toBeTruthy();
    const token = loginRes.body.accessToken as string;

    const appointmentsRes = await request(app.getHttpServer())
      .get('/api/v1/appointments?from=2026-01-01T00:00:00.000Z&to=2026-12-31T23:59:59.000Z')
      .set('Authorization', `Bearer ${token}`);
    expect(appointmentsRes.status).toBe(200);
    expect(appointmentsRes.headers['x-correlation-id']).toBeTruthy();

    const billingsRes = await request(app.getHttpServer())
      .get('/api/v1/billings')
      .set('Authorization', `Bearer ${token}`);
    expect(billingsRes.status).toBe(200);
    expect(billingsRes.headers['x-correlation-id']).toBeTruthy();
  });
});

describe('[AD-016] GET /metrics — MetricsAccessGuard', () => {
  it('rejeita sem token (401)', async () => {
    const res = await request(app.getHttpServer()).get('/metrics');
    expect(res.status).toBe(401);
  });

  it('rejeita com token errado (401)', async () => {
    const res = await request(app.getHttpServer()).get('/metrics').set('X-Metrics-Token', 'token-errado');
    expect(res.status).toBe(401);
  });

  it('aceita com o token correto e devolve texto no formato de exposição do Prometheus', async () => {
    const res = await request(app.getHttpServer())
      .get('/metrics')
      .set('X-Metrics-Token', process.env.METRICS_ACCESS_TOKEN ?? '');
    expect(res.status).toBe(200);
    expect(res.text).toContain('# HELP');
    expect(res.text).toContain('# TYPE');
  });

  it('fica fora do prefixo /api/v1 — GET /api/v1/metrics não existe', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/metrics')
      .set('X-Metrics-Token', process.env.METRICS_ACCESS_TOKEN ?? '');
    expect(res.status).toBe(404);
  });
});
