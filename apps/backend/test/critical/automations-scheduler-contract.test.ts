import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootstrapTestApp } from './support/bootstrap-app';

/**
 * [CRÍTICO — Tarefa 04 da auditoria] O que um agendador externo (n8n, cron)
 * encontra ao chamar as rotas de automação, pelo HTTP real.
 *
 * Só a autenticação da chamada é contrato firme hoje. A execução em si está
 * registrada como pendência, não como teste: com a chave certa, as quatro
 * rotas respondem 500, porque nenhuma camada inicializa a clínica da
 * requisição (o tenantId vem no corpo e não chega ao TenantContext). Ver
 * docs/07-Infra/AUTOMACOES_AGENDADOR.md.
 */

const ROUTES = [
  '/api/v1/automations/agenda-summary/send',
  '/api/v1/automations/agenda-summary/resend',
  '/api/v1/automations/inadimplencia/execute',
  '/api/v1/automations/fechamento-mensal/generate',
];

let app: INestApplication;
let savedKey: string | undefined;

beforeAll(async () => {
  savedKey = process.env.AUTOMATION_API_KEY;
  process.env.AUTOMATION_API_KEY = 'chave-de-automacao-de-teste-nao-usar-em-producao-2026';
  app = await bootstrapTestApp();
});

afterAll(async () => {
  await app?.close();
  if (savedKey === undefined) delete process.env.AUTOMATION_API_KEY;
  else process.env.AUTOMATION_API_KEY = savedKey;
});

describe('[CRÍTICO — Tarefa 04] Rotas de automação: autenticação do agendador', () => {
  it.each(ROUTES)('%s sem a chave: 401, no formato oficial de erro', async (route) => {
    const res = await request(app.getHttpServer()).post(route).send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it.each(ROUTES)('%s com chave errada: 401', async (route) => {
    const res = await request(app.getHttpServer()).post(route).set('X-Automation-Api-Key', 'chave-errada').send({});

    expect(res.status).toBe(401);
  });

  it('um token de usuário não substitui a chave de automação', async () => {
    const res = await request(app.getHttpServer())
      .post(ROUTES[2])
      .set('Authorization', 'Bearer um-token-qualquer')
      .send({ tenantId: '11111111-1111-4111-8111-111111111111' });

    expect(res.status).toBe(401);
  });

  it.todo(
    'com a chave certa, a rotina executa para a clínica indicada — hoje responde 500 (TenantContext nunca é inicializado nas rotas de automação)',
  );
});
