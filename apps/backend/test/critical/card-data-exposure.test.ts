import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { inspect } from 'node:util';
import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * [CRÍTICO — Fase 2 da auditoria, R5] Dado de cartão não fica exposto.
 *
 * POST /subscription/credit-card recebe número e CCV e os repassa à Asaas.
 * Este arquivo prova, com HTTP real e Postgres real, que esses dados não
 * aparecem na resposta, em nenhum log (inclusive o de erro e os spans do
 * OpenTelemetry) nem em nenhuma tabela — mesmo no pior caso, em que a Asaas
 * devolve um erro ecoando o cartão.
 *
 * A rede é substituída (fetch global) e ASAAS_BASE_URL aponta para um
 * endereço inválido durante o arquivo: nenhuma chamada real à Asaas.
 */

const PAN = '4111111111111111';
const CCV = '9173';
const ASAAS_SUBSCRIPTION_ID = 'sub_teste_r5_exposicao';

let app: INestApplication;
let fixturePrisma: PrismaClient;
let fixture: DedicatedFixture;
let adminToken: string;
let fetchMock: ReturnType<typeof vi.fn>;
const savedEnv = { key: process.env.ASAAS_API_KEY, url: process.env.ASAAS_BASE_URL };

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

function asaasResponse(status: number, body: string): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) } as unknown as Response;
}

const cardBody = () => ({
  holderName: 'Maria Teste',
  number: PAN,
  expiryMonth: '12',
  expiryYear: '2031',
  ccv: CCV,
  holderEmail: 'maria@clinica.dev',
  holderCpfCnpj: '12345678909',
});

/** Captura tudo o que o processo escreveria em log durante `fn`: Logger do Nest, console e stdout/stderr. */
async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const captured: string[] = [];
  const record = (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' '));
  };
  const spies = [
    ...(['log', 'error', 'warn', 'debug', 'verbose'] as const).map((level) =>
      vi.spyOn(Logger.prototype, level).mockImplementation(record),
    ),
    ...(['log', 'error', 'warn', 'info', 'debug', 'dir'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(record),
    ),
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      record(String(chunk));
      return true;
    }),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      record(String(chunk));
      return true;
    }),
  ];
  try {
    await fn();
    // SimpleSpanProcessor exporta o span depois de a resposta terminar.
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
  return captured.join('\n');
}

const postCard = (body: unknown) =>
  request(app.getHttpServer()).post('/api/v1/subscription/credit-card').set('Authorization', `Bearer ${adminToken}`).send(body as object);

beforeAll(async () => {
  process.env.ASAAS_API_KEY = 'chave-falsa-de-teste-critico';
  process.env.ASAAS_BASE_URL = 'http://asaas.invalid/v3';

  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  app = await bootstrapTestApp();
  fixture = await createDedicatedFixture(fixturePrisma, 'R5CARTAO', { withActiveSubscription: true });
  await fixturePrisma.clinicSubscription.update({
    where: { id: fixture.subscriptionId },
    data: { asaasSubscriptionId: `${ASAAS_SUBSCRIPTION_ID}_${fixture.tenantId}` },
  });
  adminToken = await createDedicatedUserAndLogin(fixturePrisma, app, fixture, 'R5CARTAO');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await fixturePrisma.$disconnect();
  await app?.close();
  if (savedEnv.key === undefined) delete process.env.ASAAS_API_KEY;
  else process.env.ASAAS_API_KEY = savedEnv.key;
  if (savedEnv.url === undefined) delete process.env.ASAAS_BASE_URL;
  else process.env.ASAAS_BASE_URL = savedEnv.url;
});

describe('[CRÍTICO — R5] Dado de cartão não fica exposto', () => {
  it('caminho feliz: o cartão vai só para a Asaas; resposta e logs não contêm número nem CCV', async () => {
    fetchMock = vi.fn().mockResolvedValue(asaasResponse(200, '{}'));
    vi.stubGlobal('fetch', fetchMock);

    let res!: request.Response;
    const output = await captureOutput(async () => {
      res = await postCard(cardBody());
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: 'attached' });

    // O dado chegou ao provedor — e só a ele, numa única chamada.
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('http://asaas.invalid/v3/subscriptions/');
    expect(String(url).endsWith('/creditCard')).toBe(true);
    expect(JSON.parse(init.body).creditCard.number).toBe(PAN);

    expect(JSON.stringify(res.body)).not.toContain(PAN);
    expect(output).not.toContain(PAN);
    expect(output).not.toContain(CCV);
  });

  it('pior caso: a Asaas devolve erro ecoando o cartão — resposta genérica, e o log do erro não contém número nem CCV', async () => {
    const echoed = JSON.stringify({
      errors: [{ code: 'invalid_creditCard', description: `Cartão ${PAN} recusado` }],
      creditCard: { holderName: 'Maria Teste', number: PAN, ccv: CCV },
    });
    fetchMock = vi.fn().mockResolvedValue(asaasResponse(400, echoed));
    vi.stubGlobal('fetch', fetchMock);

    let res!: request.Response;
    const output = await captureOutput(async () => {
      res = await postCard(cardBody());
    });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(res.text).not.toContain(PAN);
    expect(res.text).not.toContain(CCV);

    // O erro FOI logado (o filtro registra todo 500) — sem o dado de cartão.
    expect(output).toContain('Falha na chamada Asaas PUT');
    expect(output).toContain('invalid_creditCard');
    expect(output).not.toContain(PAN);
    expect(output).not.toContain(CCV);
  });

  it('erro de validação não ecoa o valor enviado', async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    let res!: request.Response;
    const output = await captureOutput(async () => {
      res = await postCard({ ...cardBody(), number: Number(PAN), campoInesperado: CCV });
    });

    expect(res.status).toBe(400);
    expect(res.text).not.toContain(PAN);
    expect(res.text).not.toContain(CCV);
    expect(output).not.toContain(PAN);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('nada do cartão foi gravado: auditoria, assinatura, notificações e log de mensagens do Tenant', async () => {
    const [audit, subscription, notifications, messageLogs] = await Promise.all([
      fixturePrisma.auditLog.findMany({ where: { tenantId: fixture.tenantId } }),
      fixturePrisma.clinicSubscription.findMany({ where: { tenantId: fixture.tenantId } }),
      fixturePrisma.notification.findMany({ where: { tenantId: fixture.tenantId } }),
      fixturePrisma.messageLog.findMany({ where: { tenantId: fixture.tenantId } }),
    ]);
    const stored = JSON.stringify({ audit, subscription, notifications, messageLogs });
    expect(stored).not.toContain(PAN);
    expect(stored).not.toContain(`"${CCV}"`);

    // Varredura no banco inteiro: nenhuma linha de auditoria, de qualquer Tenant, contém o número.
    const rows = await fixturePrisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM audit_log WHERE payload::text LIKE ${`%${PAN}%`}
    `;
    expect(Number(rows[0].count)).toBe(0);
  });
});
