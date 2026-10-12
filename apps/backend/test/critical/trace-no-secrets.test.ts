import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { SpanKind } from '@opentelemetry/api';
import { bootstrapTestApp } from './support/bootstrap-app';
import { startTraceCapture, type TraceCapture } from '../support/trace-capture';

/**
 * Tarefa 07 da auditoria (Fase 1) — nenhum segredo e nenhum dado de paciente
 * no que o backend exporta como trace.
 *
 * O app é o de verdade (bootstrapTestApp(), os mesmos guards, pipes e filtro
 * de main.ts) e as instrumentações são as de produção, ligadas de verdade;
 * só o destino dos spans é uma lista em memória (ver
 * test/support/trace-capture.ts). Nenhuma chamada à Meta: a verificação do
 * webhook é feita aqui mesmo, do jeito que a Meta a faz — com o token na
 * query string, que é o que o protocolo exige e o que vazava.
 *
 * O que vazava, medido antes da correção com estas mesmas instrumentações:
 *   - `url.query` do span da requisição, com `hub.verify_token` inteiro;
 *   - `db.query.text` do span do Redis, com o job que o BullMQ enfileira —
 *     telefone do paciente e texto da mensagem.
 */
const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? '';
const WEBHOOK = '/api/v1/webhooks/whatsapp';

let capture: TraceCapture;
let app: INestApplication;

function serverSpans() {
  return capture.spans().filter((span) => span.kind === SpanKind.SERVER);
}

beforeAll(async () => {
  // Antes de o app existir: as rotas têm de ser registradas com as instrumentações já ligadas.
  capture = startTraceCapture();
  app = await bootstrapTestApp();
});

afterAll(async () => {
  await app?.close();
  await capture.stop();
});

beforeEach(() => capture.reset());

describe('[Tarefa 07] verificação do webhook da Meta — o token não vai para o trace', () => {
  it('o token de verificação configurado existe e é o que o teste procura', () => {
    expect(VERIFY_TOKEN.length).toBeGreaterThan(8);
  });

  it('handshake aceito: 200, e o span da requisição leva os nomes dos parâmetros sem o token nem o desafio', async () => {
    const response = await request(app.getHttpServer())
      .get(WEBHOOK)
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'desafio-7781234' });
    expect(response.status).toBe(200);
    expect(response.text).toBe('desafio-7781234');

    const [incoming] = serverSpans();
    expect(incoming, 'span da requisição recebida').toBeDefined();
    expect(incoming.attributes['url.path']).toBe(WEBHOOK);
    expect(incoming.attributes['url.query']).toBe('hub.mode=subscribe&hub.verify_token=REDACTED&hub.challenge=REDACTED');
    expect(incoming.attributes['http.response.status_code']).toBe(200);

    expect(capture.exported()).not.toContain(VERIFY_TOKEN);
    expect(capture.exported()).not.toContain('desafio-7781234');
  });

  it('handshake recusado: 403, e o token errado que alguém tentou também não é gravado', async () => {
    const response = await request(app.getHttpServer())
      .get(WEBHOOK)
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tentativa-de-token-errado-4471', 'hub.challenge': 'x' });
    expect(response.status).toBe(403);

    expect(serverSpans()).toHaveLength(1);
    expect(serverSpans()[0].attributes['http.response.status_code']).toBe(403);
    expect(capture.exported()).not.toContain('tentativa-de-token-errado-4471');
    expect(response.text).not.toContain('tentativa-de-token-errado-4471');
  });

  it('a requisição de saída (aqui, a do próprio teste) também fica sem o token no endereço completo', async () => {
    await request(app.getHttpServer()).get(WEBHOOK).query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1' });

    const outgoing = capture.spans().find((span) => span.kind === SpanKind.CLIENT);
    expect(outgoing, 'span da requisição enviada').toBeDefined();
    expect(String(outgoing?.attributes['url.full'])).toContain(`${WEBHOOK}?hub.mode=subscribe&hub.verify_token=REDACTED&hub.challenge=REDACTED`);
  });

  it('erro 500 na verificação (token não configurado): nem o log de erro, nem a resposta, nem o span levam o token recebido', async () => {
    const logged: string[] = [];
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation((...parts: unknown[]) => {
      logged.push(parts.map(String).join(' '));
    });
    const configured = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    try {
      const response = await request(app.getHttpServer())
        .get(WEBHOOK)
        .set('X-Correlation-Id', 'correlacao-da-verificacao')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'token-enviado-no-erro-9902', 'hub.challenge': '1' });

      expect(response.status).toBe(500);
      expect(JSON.stringify(response.body)).not.toContain('token-enviado-no-erro-9902');
      expect(logged.join('\n')).toContain('correlacao-da-verificacao');
      expect(logged.join('\n')).not.toContain('token-enviado-no-erro-9902');
      expect(serverSpans()[0].attributes['http.response.status_code']).toBe(500);
      expect(capture.exported()).not.toContain('token-enviado-no-erro-9902');
    } finally {
      process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = configured;
      errorLog.mockRestore();
    }
  });
});

describe('[Tarefa 07] o que continua no trace, e o que nunca entrou', () => {
  it('rota com filtros: ficam o caminho, a rota, o status, os nomes dos parâmetros e a paginação; ids e cursor saem', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/patients')
      .query({ limit: '5', cursor: 'cursor-opaco-551', patientId: 'id-de-paciente-8842' });
    expect(response.status).toBe(401);

    const [incoming] = serverSpans();
    expect(incoming.attributes['url.path']).toBe('/api/v1/patients');
    expect(incoming.attributes['url.query']).toBe('limit=5&cursor=REDACTED&patientId=REDACTED');
    expect(incoming.attributes['http.request.method']).toBe('GET');
    expect(incoming.attributes['http.response.status_code']).toBe(401);
    expect(capture.exported()).not.toContain('id-de-paciente-8842');
    expect(capture.exported()).not.toContain('cursor-opaco-551');
  });

  it('cabeçalhos de credencial (sessão, automação, assinatura do webhook) e o corpo não são gravados', async () => {
    await request(app.getHttpServer())
      .post(WEBHOOK)
      .set('Authorization', 'Bearer credencial-de-sessao-1717')
      .set('X-Automation-Api-Key', 'chave-de-automacao-2828')
      .set('X-Hub-Signature-256', 'sha256=assinatura-3939')
      .send({ entry: [{ changes: [{ value: { messages: [{ text: { body: 'corpo-da-mensagem-4040' } }] } }] }] });

    expect(serverSpans()).toHaveLength(1);
    const exported = capture.exported();
    for (const secret of ['credencial-de-sessao-1717', 'chave-de-automacao-2828', 'assinatura-3939', 'corpo-da-mensagem-4040']) {
      expect(exported).not.toContain(secret);
    }
  });
});

describe('[Tarefa 07] fila (BullMQ sobre Redis) — o job não vai para o trace', () => {
  const PHONE = '5541988887777';
  const TEXT = 'mensagem sigilosa do paciente sobre a consulta';

  it('enfileirar um job grava o comando e o script, nunca o telefone, o texto ou o id do job', async () => {
    // Fila própria deste teste, no Redis da suíte: nenhum worker de outro arquivo a consome.
    const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    const queue = new Queue(`trace-no-secrets-${randomUUID()}`, { connection });
    const jobId = `wamid.HBgM${PHONE}FQIAEhg`;
    try {
      await capture.inSpan('enfileirar', () => queue.add('mensagem', { tenantId: randomUUID(), to: PHONE, text: TEXT }, { jobId }));

      const statements = capture
        .spans()
        .map((span) => span.attributes['db.query.text'] ?? span.attributes['db.statement'])
        .filter((statement): statement is string => typeof statement === 'string');
      expect(statements.length, 'comandos Redis capturados').toBeGreaterThan(0);
      expect(statements.some((statement) => /^evalsha [0-9a-f]{40} \[\d+ other arguments\]$/.test(statement))).toBe(true);
      for (const statement of statements) {
        expect(statement).toMatch(/^[a-z_]+( [0-9a-f]{40})?( \[\d+ (other )?arguments\])?$/i);
      }

      const exported = capture.exported();
      expect(exported).not.toContain(PHONE);
      expect(exported).not.toContain(TEXT);
      expect(exported).not.toContain('wamid');
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      await connection.quit();
    }
  });
});
