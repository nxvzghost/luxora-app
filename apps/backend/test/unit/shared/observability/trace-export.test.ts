import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SpanKind } from '@opentelemetry/api';
import { startTraceCapture, type TraceCapture } from '../../../support/trace-capture';

/**
 * Tarefa 07 da auditoria (Fase 1) — o que a instrumentação de HTTP exporta.
 *
 * As instrumentações são as de produção, ligadas de verdade sobre um servidor
 * HTTP mínimo; os spans são lidos em memória. Sem banco, sem Redis, sem rede
 * externa. O mesmo com o app inteiro: test/critical/trace-no-secrets.test.ts.
 */
const TOKEN = 'token-de-verificacao-que-nao-pode-vazar';
const HEADER_SECRET = 'segredo-de-cabecalho-que-nao-pode-vazar';

let capture: TraceCapture;
let server: http.Server;
let port: number;

function get(path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get({ port, path, headers }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      })
      .on('error', reject);
  });
}

beforeAll(async () => {
  capture = startTraceCapture();
  server = http.createServer((_request, response) => response.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await capture.stop();
});

beforeEach(() => capture.reset());

describe('instrumentação de HTTP — o que vai para o trace', () => {
  it('requisição que chega: a query fica com os nomes, sem os valores; o caminho continua inteiro', async () => {
    await get(`/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=998877`);

    const incoming = capture.spans().find((span) => span.kind === SpanKind.SERVER);
    expect(incoming, 'span da requisição recebida').toBeDefined();
    expect(incoming?.attributes['url.path']).toBe('/api/v1/webhooks/whatsapp');
    expect(incoming?.attributes['url.query']).toBe('hub.mode=subscribe&hub.verify_token=REDACTED&hub.challenge=REDACTED');
    expect(incoming?.attributes['http.request.method']).toBe('GET');
    expect(incoming?.attributes['http.response.status_code']).toBe(200);
  });

  it('requisição que sai: o endereço completo também fica sem os valores', async () => {
    await get(`/v21.0/123/messages?access_token=${TOKEN}&limit=5`);

    const outgoing = capture.spans().find((span) => span.kind === SpanKind.CLIENT);
    expect(outgoing, 'span da requisição enviada').toBeDefined();
    expect(outgoing?.attributes['url.full']).toBe(`http://localhost:${port}/v21.0/123/messages?access_token=REDACTED&limit=5`);
  });

  it('nada do que foi exportado contém o token — nem na query, nem em cabeçalho', async () => {
    await get(`/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${TOKEN}`, {
      authorization: `Bearer ${HEADER_SECRET}`,
      'x-automation-api-key': HEADER_SECRET,
      'x-hub-signature-256': `sha256=${HEADER_SECRET}`,
    });

    expect(capture.spans().length).toBeGreaterThanOrEqual(2);
    expect(capture.exported()).not.toContain(TOKEN);
    expect(capture.exported()).not.toContain(HEADER_SECRET);
  });

  it('sem query, os atributos ficam como a instrumentação os gravou', async () => {
    await get('/api/v1/patients');

    const incoming = capture.spans().find((span) => span.kind === SpanKind.SERVER);
    expect(incoming?.attributes['url.path']).toBe('/api/v1/patients');
    expect(incoming?.attributes['url.query']).toBeUndefined();
  });

  it('sondas de saúde e coleta de métricas continuam sem trace', async () => {
    await get('/api/v1/health/ready');
    await get('/metrics');

    expect(capture.spans().filter((span) => span.kind === SpanKind.SERVER)).toHaveLength(0);
  });
});
