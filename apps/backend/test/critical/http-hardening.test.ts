import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootstrapTestApp } from './support/bootstrap-app';

/**
 * [CRÍTICO — ADR-0057] Endurecimento da borda HTTP (Fase 2 da auditoria, R7).
 *
 * Sobe o app real duas vezes — como desenvolvimento e como produção — pelas
 * mesmas funções que main.ts chama (applySecurityHeaders/setupSwagger), e
 * confere os headers de segurança e a exposição da documentação em cada
 * modo. NODE_ENV só é trocado durante o bootstrap do app de produção e é
 * restaurado em seguida: a decisão é lida no momento do registro das rotas.
 */

let devApp: INestApplication;
let prodApp: INestApplication;

beforeAll(async () => {
  devApp = await bootstrapTestApp();

  const savedNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    prodApp = await bootstrapTestApp();
  } finally {
    process.env.NODE_ENV = savedNodeEnv;
  }
});

afterAll(async () => {
  await devApp?.close();
  await prodApp?.close();
});

describe('[CRÍTICO — ADR-0057] Headers de segurança (Helmet)', () => {
  it.each([
    ['desenvolvimento', () => devApp],
    ['produção', () => prodApp],
  ])('em %s, toda resposta sai com os headers de segurança e sem X-Powered-By', async (_mode, getApp) => {
    const res = await request(getApp().getHttpServer()).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('respostas de erro também saem com os headers (401 de rota protegida)', async () => {
    const res = await request(prodApp.getHttpServer()).get('/api/v1/users');
    expect(res.status).toBe(401);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    // O Correlation ID (AD-016) continua presente junto com o Helmet.
    expect(res.headers['x-correlation-id']).toBeTruthy();
  });

  it('em produção a CSP é a padrão do Helmet, sem script inline', async () => {
    const res = await request(prodApp.getHttpServer()).get('/api/v1/health');
    const csp = res.headers['content-security-policy'] as string;
    const scriptSrc = csp.split(';').find((directive) => directive.trim().startsWith('script-src ')) ?? '';
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });
});

describe('[CRÍTICO — ADR-0057] Swagger por ambiente', () => {
  it('fora de produção, a documentação está disponível', async () => {
    const ui = await request(devApp.getHttpServer()).get('/api/v1/docs');
    expect(ui.status).toBe(200);
    expect(ui.text).toContain('swagger');

    const json = await request(devApp.getHttpServer()).get('/api/v1/docs-json');
    expect(json.status).toBe(200);
    expect(json.body.info.title).toBe('Luxora API');
  });

  it('em produção, a documentação não é registrada: UI, JSON e YAML respondem 404', async () => {
    for (const path of ['/api/v1/docs', '/api/v1/docs/', '/api/v1/docs-json', '/api/v1/docs-yaml']) {
      const res = await request(prodApp.getHttpServer()).get(path);
      expect(res.status, path).toBe(404);
    }
  });

  it('em produção, a API em si continua respondendo normalmente', async () => {
    const health = await request(prodApp.getHttpServer()).get('/api/v1/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');

    // Rota de autenticação continua alcançável (credenciais inválidas → 401, não 404).
    const login = await request(prodApp.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'ninguem@luxora.dev', password: 'senha-invalida' });
    expect(login.status).toBe(401);
  });
});
