import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootstrapTestApp } from './support/bootstrap-app';
import { ReadinessService } from '@infrastructure/health/readiness.service';

/**
 * [CRÍTICO — Tarefa 04 da auditoria] Sondas de saúde, no app real, com o
 * Postgres e o Redis de verdade.
 *
 * É o que a plataforma de deploy consulta para decidir se uma versão nova
 * pode receber tráfego — e o que dispara o rollback quando ela não fica
 * pronta. A queda real de uma dependência (container parado) é exercitada
 * em infra/tests, contra a imagem.
 */

let app: INestApplication;

beforeAll(async () => {
  app = await bootstrapTestApp();
});

afterAll(async () => {
  await app?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Probes = { pingDatabase: () => Promise<void>; pingRedis: () => Promise<void>; shuttingDown: boolean };
const probes = () => app.get(ReadinessService) as unknown as Probes;

describe('[CRÍTICO — Tarefa 04] GET /api/v1/health/ready', () => {
  it('200 "ready" com Postgres e Redis reais respondendo, sem autenticação', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', checks: { database: 'up', redis: 'up' } });
  });

  it('503 "not_ready" quando o Postgres não responde — e diz qual dependência caiu, sem detalhe de conexão', async () => {
    vi.spyOn(probes(), 'pingDatabase').mockRejectedValue(new Error('connect ECONNREFUSED db.interno:5432'));

    const res = await request(app.getHttpServer()).get('/api/v1/health/ready');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready', checks: { database: 'down', redis: 'up' } });
    expect(JSON.stringify(res.body)).not.toContain('db.interno');
  });

  it('503 "not_ready" quando o Redis não responde', async () => {
    vi.spyOn(probes(), 'pingRedis').mockRejectedValue(new Error('Connection is closed.'));

    const res = await request(app.getHttpServer()).get('/api/v1/health/ready');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready', checks: { database: 'up', redis: 'down' } });
  });

  it('o liveness continua 200 com dependência fora do ar: o processo está de pé e não deve ser reiniciado', async () => {
    vi.spyOn(probes(), 'pingDatabase').mockRejectedValue(new Error('fora do ar'));
    vi.spyOn(probes(), 'pingRedis').mockRejectedValue(new Error('fora do ar'));

    const res = await request(app.getHttpServer()).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBe(process.env.APP_VERSION ?? 'dev');
  });

  it('volta a "ready" quando a dependência volta', async () => {
    const spy = vi.spyOn(probes(), 'pingRedis').mockRejectedValue(new Error('fora do ar'));
    expect((await request(app.getHttpServer()).get('/api/v1/health/ready')).status).toBe(503);

    spy.mockRestore();

    expect((await request(app.getHttpServer()).get('/api/v1/health/ready')).status).toBe(200);
  });

  it('503 "shutting_down" assim que o encerramento começa, com o servidor ainda aceitando conexões', async () => {
    const service = probes();
    service.shuttingDown = true;
    try {
      const res = await request(app.getHttpServer()).get('/api/v1/health/ready');

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'shutting_down' });
    } finally {
      service.shuttingDown = false;
    }
  });

  it('as sondas saem com os mesmos headers de segurança e Correlation ID das demais rotas', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-correlation-id']).toBeTruthy();
  });
});
