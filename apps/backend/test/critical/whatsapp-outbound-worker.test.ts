import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';
import { MessageJobData, MessageQueueProducer } from '@infrastructure/messaging/message-queue.producer';
import { MessageQueueWorker } from '@infrastructure/messaging/message-queue.worker';
import { TokenCipherService } from '@shared/token-cipher.service';

/**
 * Fase 3 da auditoria — fila de saída do WhatsApp ('messages').
 *
 * Prova, contra Postgres/Redis/BullMQ reais, que o job enfileirado é de
 * fato consumido e chega à chamada da Graph API da Meta com a credencial
 * da clínica dona do job. Só `fetch` é interceptado — nenhuma chamada sai
 * da máquina; todo o resto (MessageQueueProducer, MessageQueueWorker,
 * ModuleRef/ContextIdFactory, EnviarMensagemUseCase, RLS de message_log,
 * WhatsAppMessageProvider, TokenCipherService) é o código real.
 *
 * Antes da correção este arquivo falha já no primeiro teste:
 * MessageQueueWorker herdava Scope.REQUEST e nunca era instanciado.
 *
 * Redis: esta suíte usa um banco lógico próprio (índice 14), separado do
 * banco do restante da suíte crítica (índice 13, ver
 * support/global-setup.ts). É a única com um consumidor real da fila
 * 'messages'; no banco compartilhado ele disputaria (e "enviaria") jobs
 * de saída enfileirados por outros arquivos da suíte.
 */

const ISOLATED_REDIS_DB = '14';

let app: INestApplication;
let fixturePrisma: PrismaClient;
let queueConnection: IORedis;
let queue: Queue<MessageJobData>;
let originalRedisUrl: string | undefined;

let tenantA: DedicatedFixture;
let tenantB: DedicatedFixture;
let tenantSemCanal: DedicatedFixture;

const phoneNumberIdA = `pnid-a-${randomUUID()}`;
const phoneNumberIdB = `pnid-b-${randomUUID()}`;
const tokenA = `EAAG-token-da-clinica-A-${randomUUID()}`;
const tokenB = `EAAG-token-da-clinica-B-${randomUUID()}`;

interface FakeResponse {
  status: number;
  body: unknown;
  /** Cabeçalhos da resposta simulada (nomes em minúsculas). */
  headers?: Record<string, string>;
  /** Tempo que a Meta simulada leva para responder. */
  delayMs?: number;
}

/** Respostas simuladas da Meta, por marcador único embutido no texto da mensagem. */
const scriptedResponses = new Map<string, FakeResponse[]>();
/** Instante de cada chamada simulada, por marcador — para medir a espera entre tentativas. */
const callTimes = new Map<string, number[]>();
/** O último teste fecha a aplicação de propósito; o afterAll não pode fechar de novo. */
let appClosed = false;

function okResponse(wamid: string): FakeResponse {
  return { status: 200, body: { messages: [{ id: wamid }] } };
}

function errorResponse(status: number, code: number): FakeResponse {
  return {
    status,
    body: {
      error: {
        message: 'texto livre devolvido pela Meta — nunca pode aparecer no motivo da falha',
        type: 'OAuthException',
        code,
        fbtrace_id: 'trace-de-teste',
      },
    },
  };
}

const fetchMock = vi.fn(async (_url: string, opts: { body: string; headers: Record<string, string> }) => {
  const sent = JSON.parse(opts.body) as { text: { body: string } };
  const marker = [...scriptedResponses.keys()].find((key) => sent.text.body.includes(key));
  const next = marker ? scriptedResponses.get(marker)?.shift() : undefined;
  const response = next ?? errorResponse(400, 100);
  if (marker) {
    callTimes.set(marker, [...(callTimes.get(marker) ?? []), Date.now()]);
  }
  if (response.delayMs) {
    await new Promise((resolve) => setTimeout(resolve, response.delayMs));
  }
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    headers: { get: (name: string) => response.headers?.[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(response.body),
    json: async () => response.body,
  };
});

function callsFor(marker: string) {
  return fetchMock.mock.calls.filter(([, opts]) => opts.body.includes(marker));
}

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

async function waitForFinalState(jobId: string, timeoutMs = 20000): Promise<'completed' | 'failed'> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await queue.getJob(jobId);
    const state = job ? await job.getState() : 'unknown';
    if (state === 'completed' || state === 'failed') return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout esperando o job ${jobId} chegar a um estado final.`);
}

function jobData(tenantId: string, marker: string, overrides: Partial<MessageJobData> = {}): MessageJobData {
  return {
    tenantId,
    toPhoneNumber: '5500000000000',
    body: `Mensagem de teste ${marker}`,
    idempotencyKey: `outbound-test-${marker}`,
    correlationId: `corr-${marker}`,
    ...overrides,
  };
}

beforeAll(async () => {
  originalRedisUrl = process.env.REDIS_URL;
  const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  redisUrl.pathname = `/${ISOLATED_REDIS_DB}`;
  process.env.REDIS_URL = redisUrl.toString();

  vi.stubGlobal('fetch', fetchMock);

  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();

  queueConnection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue<MessageJobData>('messages', { connection: queueConnection });
  await queue.obliterate({ force: true });

  app = await bootstrapTestApp({ realMessageQueueWorker: true });

  tenantA = await createDedicatedFixture(fixturePrisma, 'WAOUTA');
  tenantB = await createDedicatedFixture(fixturePrisma, 'WAOUTB');
  tenantSemCanal = await createDedicatedFixture(fixturePrisma, 'WAOUTC');

  const tokenCipher = new TokenCipherService();
  await fixturePrisma.whatsAppIntegration.create({
    data: { tenantId: tenantA.tenantId, phoneNumberId: phoneNumberIdA, accessToken: tokenCipher.encrypt(tokenA), active: true },
  });
  await fixturePrisma.whatsAppIntegration.create({
    data: { tenantId: tenantB.tenantId, phoneNumberId: phoneNumberIdB, accessToken: tokenCipher.encrypt(tokenB), active: true },
  });
});

afterAll(async () => {
  if (!appClosed) {
    await app?.close();
  }
  await queue.obliterate({ force: true });
  await queue.close();
  await queueConnection.quit();

  const tenantIds = [tenantA, tenantB, tenantSemCanal].filter(Boolean).map((fixture) => fixture.tenantId);
  await fixturePrisma.messageLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await fixturePrisma.whatsAppIntegration.deleteMany({ where: { tenantId: { in: tenantIds } } });
  for (const fixture of [tenantA, tenantB, tenantSemCanal].filter(Boolean)) {
    await cleanupDedicatedFixture(fixturePrisma, fixture);
  }
  await fixturePrisma.$disconnect();

  vi.unstubAllGlobals();
  if (originalRedisUrl === undefined) {
    delete process.env.REDIS_URL;
  } else {
    process.env.REDIS_URL = originalRedisUrl;
  }
});

describe('[Fase 3] Fila de saída do WhatsApp — MessageQueueWorker', () => {
  it('o worker é instanciado no boot e está registrado como consumidor da fila', async () => {
    expect(app.get(MessageQueueWorker)).toBeInstanceOf(MessageQueueWorker);
    expect((await queue.getWorkers()).length).toBeGreaterThanOrEqual(1);
  });

  it('job enfileirado → consumido → enviado com a credencial da própria clínica → registrado em message_log', async () => {
    const marker = randomUUID();
    scriptedResponses.set(marker, [okResponse(`wamid.${marker}`)]);
    const data = jobData(tenantA.tenantId, marker);

    await app.get(MessageQueueProducer).enqueue(data);
    expect(await waitForFinalState(data.idempotencyKey)).toBe('completed');

    const calls = callsFor(marker);
    expect(calls).toHaveLength(1);
    const [url, opts] = calls[0];
    expect(url).toContain(`/${phoneNumberIdA}/messages`);
    expect(opts.headers.Authorization).toBe(`Bearer ${tokenA}`);
    expect(opts.headers['X-Correlation-Id']).toBe(data.correlationId);

    const rows = await fixturePrisma.messageLog.findMany({ where: { idempotencyKey: data.idempotencyKey } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(tenantA.tenantId);
    expect(rows[0].providerMessageId).toBe(`wamid.${marker}`);
  });

  it('isolamento: o job da clínica B usa só o número e o token da clínica B, e o registro fica só na clínica B', async () => {
    const marker = randomUUID();
    scriptedResponses.set(marker, [okResponse(`wamid.${marker}`)]);
    const data = jobData(tenantB.tenantId, marker);

    await app.get(MessageQueueProducer).enqueue(data);
    expect(await waitForFinalState(data.idempotencyKey)).toBe('completed');

    const calls = callsFor(marker);
    expect(calls).toHaveLength(1);
    const [url, opts] = calls[0];
    expect(url).toContain(`/${phoneNumberIdB}/messages`);
    expect(url).not.toContain(phoneNumberIdA);
    expect(opts.headers.Authorization).toBe(`Bearer ${tokenB}`);

    const rows = await fixturePrisma.messageLog.findMany({ where: { idempotencyKey: data.idempotencyKey } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(tenantB.tenantId);
    expect(await fixturePrisma.messageLog.count({ where: { tenantId: tenantA.tenantId, idempotencyKey: data.idempotencyKey } })).toBe(0);
  });

  it('idempotência: o mesmo envio enfileirado de novo (mesmo jobId e, depois, jobId diferente) nunca gera segunda chamada', async () => {
    const marker = randomUUID();
    scriptedResponses.set(marker, [okResponse(`wamid.${marker}`), okResponse(`wamid.duplicada-${marker}`)]);
    const data = jobData(tenantA.tenantId, marker);

    await app.get(MessageQueueProducer).enqueue(data);
    expect(await waitForFinalState(data.idempotencyKey)).toBe('completed');

    // Camada do BullMQ: mesmo jobId, nem chega a ser enfileirado de novo.
    await app.get(MessageQueueProducer).enqueue(data);

    // Camada do Use Case: outro jobId (como um reenfileiramento por outro
    // caminho), mesma chave de idempotência — barrado por message_log.
    const otherJobId = `outro-job-${marker}`;
    await queue.add('send-message', data, { jobId: otherJobId, attempts: 3, backoff: { type: 'exponential', delay: 2000 } });
    expect(await waitForFinalState(otherJobId)).toBe('completed');

    expect(callsFor(marker)).toHaveLength(1);
    expect(await fixturePrisma.messageLog.count({ where: { idempotencyKey: data.idempotencyKey } })).toBe(1);
  });

  it('falha repetível (500) é tentada de novo e resulta em um único envio registrado', async () => {
    const marker = randomUUID();
    scriptedResponses.set(marker, [errorResponse(500, 131000), okResponse(`wamid.${marker}`)]);
    const data = jobData(tenantA.tenantId, marker);

    await app.get(MessageQueueProducer).enqueue(data);
    expect(await waitForFinalState(data.idempotencyKey)).toBe('completed');

    expect(callsFor(marker)).toHaveLength(2);
    const job = await queue.getJob(data.idempotencyKey);
    expect(job?.attemptsMade).toBe(2);
    expect(await fixturePrisma.messageLog.count({ where: { idempotencyKey: data.idempotencyKey } })).toBe(1);
  });

  it('limite de requisições da Meta (429) também é repetível: nova tentativa e um único envio registrado', async () => {
    const marker = randomUUID();
    scriptedResponses.set(marker, [errorResponse(429, 130429), okResponse(`wamid.${marker}`)]);
    const data = jobData(tenantA.tenantId, marker);

    await app.get(MessageQueueProducer).enqueue(data);
    expect(await waitForFinalState(data.idempotencyKey)).toBe('completed');

    expect(callsFor(marker)).toHaveLength(2);
    const job = await queue.getJob(data.idempotencyKey);
    expect(job?.attemptsMade).toBe(2);
    expect(await fixturePrisma.messageLog.count({ where: { idempotencyKey: data.idempotencyKey } })).toBe(1);
  });

  it('falha repetível persistente para na 3ª tentativa — nunca repete para sempre', async () => {
    const marker = randomUUID();
    scriptedResponses.set(marker, [errorResponse(503, 131000), errorResponse(503, 131000), errorResponse(503, 131000), okResponse('nunca-usada')]);
    const data = jobData(tenantA.tenantId, marker);

    await app.get(MessageQueueProducer).enqueue(data);
    expect(await waitForFinalState(data.idempotencyKey, 25000)).toBe('failed');

    expect(callsFor(marker)).toHaveLength(3);
    expect(await fixturePrisma.messageLog.count({ where: { idempotencyKey: data.idempotencyKey } })).toBe(0);
  }, 30000);

  it('falha permanente (401, credencial recusada) encerra o job na 1ª tentativa, sem vazar token nem texto da mensagem', async () => {
    const marker = randomUUID();
    scriptedResponses.set(marker, [errorResponse(401, 190), okResponse('nunca-usada')]);
    const data = jobData(tenantA.tenantId, marker);

    await app.get(MessageQueueProducer).enqueue(data);
    expect(await waitForFinalState(data.idempotencyKey)).toBe('failed');

    expect(callsFor(marker)).toHaveLength(1);
    const job = await queue.getJob(data.idempotencyKey);
    expect(job?.attemptsMade).toBe(1);
    expect(job?.failedReason).toContain('401');
    expect(job?.failedReason).toContain('code=190');
    expect(job?.failedReason).toContain('fbtrace_id=trace-de-teste');
    expect(job?.failedReason).not.toContain(tokenA);
    expect(job?.failedReason).not.toContain(marker);
    expect(job?.failedReason).not.toContain('texto livre');
    expect(await fixturePrisma.messageLog.count({ where: { idempotencyKey: data.idempotencyKey } })).toBe(0);
  });

  it('clínica sem canal conectado: falha permanente, nenhuma chamada externa — nunca usa a credencial de outra clínica', async () => {
    const marker = randomUUID();
    scriptedResponses.set(marker, [okResponse('nunca-usada')]);
    const data = jobData(tenantSemCanal.tenantId, marker);

    await app.get(MessageQueueProducer).enqueue(data);
    expect(await waitForFinalState(data.idempotencyKey)).toBe('failed');

    expect(callsFor(marker)).toHaveLength(0);
    const job = await queue.getJob(data.idempotencyKey);
    expect(job?.attemptsMade).toBe(1);
  });

  it('payload sem tenantId válido: descartado sem tentar enviar', async () => {
    const marker = randomUUID();
    scriptedResponses.set(marker, [okResponse('nunca-usada')]);
    const data = jobData('nao-e-um-uuid', marker);

    await queue.add('send-message', data, { jobId: data.idempotencyKey, attempts: 3, backoff: { type: 'exponential', delay: 2000 } });
    expect(await waitForFinalState(data.idempotencyKey)).toBe('failed');

    expect(callsFor(marker)).toHaveLength(0);
    const job = await queue.getJob(data.idempotencyKey);
    expect(job?.attemptsMade).toBe(1);
  });

  it('retenção (Fase 3B): o job gravado no Redis leva a política de expiração — concluídos 24 h, falhados 14 dias', async () => {
    const marker = randomUUID();
    scriptedResponses.set(marker, [okResponse(`wamid.${marker}`)]);
    const data = jobData(tenantA.tenantId, marker);

    await app.get(MessageQueueProducer).enqueue(data);
    expect(await waitForFinalState(data.idempotencyKey)).toBe('completed');

    // Lido de volta do Redis real, depois de concluído: o job ainda existe
    // (está dentro das 24 h) e carrega as duas regras.
    const job = await queue.getJob(data.idempotencyKey);
    expect(job?.opts.removeOnComplete).toEqual({ age: 24 * 60 * 60 });
    expect(job?.opts.removeOnFail).toEqual({ age: 14 * 24 * 60 * 60 });
    expect(job?.opts.attempts).toBe(3);
  });

  it('Retry-After (Fase 3B): um 429 com "Retry-After: 3" espera 3 s, não os 2 s padrão', async () => {
    const marker = randomUUID();
    scriptedResponses.set(marker, [
      { ...errorResponse(429, 130429), headers: { 'retry-after': '3' } },
      okResponse(`wamid.${marker}`),
    ]);
    const data = jobData(tenantA.tenantId, marker);

    await app.get(MessageQueueProducer).enqueue(data);
    expect(await waitForFinalState(data.idempotencyKey)).toBe('completed');

    const [first, second] = callTimes.get(marker) ?? [];
    expect(callsFor(marker)).toHaveLength(2);
    expect(second - first).toBeGreaterThanOrEqual(2900);
    expect(second - first).toBeLessThan(4500);
    expect(await fixturePrisma.messageLog.count({ where: { idempotencyKey: data.idempotencyKey } })).toBe(1);
  });

  it('Retry-After absurdo (Fase 3B): "Retry-After: 86400" é limitado a 60 s — o provider não prende o job', async () => {
    const marker = randomUUID();
    scriptedResponses.set(marker, [
      { ...errorResponse(429, 130429), headers: { 'retry-after': '86400' } },
      okResponse(`wamid.${marker}`),
    ]);
    const data = jobData(tenantA.tenantId, marker);

    const enqueuedAt = Date.now();
    await app.get(MessageQueueProducer).enqueue(data);

    // Espera a 1ª tentativa falhar e o job ser agendado para depois.
    let scheduledFor = 0;
    for (let attempt = 0; attempt < 100 && scheduledFor === 0; attempt += 1) {
      const score = await queueConnection.zscore('bull:messages:delayed', data.idempotencyKey);
      // O BullMQ guarda o instante agendado nos bits altos da pontuação.
      scheduledFor = score ? Math.floor(Number(score) / 0x1000) : 0;
      if (scheduledFor === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const waitMs = scheduledFor - enqueuedAt;
    expect(waitMs).toBeGreaterThan(55_000);
    expect(waitMs).toBeLessThan(65_000); // 60 s de teto — nunca as 24 h pedidas

    // Sem esperar o minuto inteiro: antecipa o job e confere que ele conclui.
    await (await queue.getJob(data.idempotencyKey))?.promote();
    expect(await waitForFinalState(data.idempotencyKey)).toBe('completed');
    expect(callsFor(marker)).toHaveLength(2);
  });

  // ATENÇÃO: este precisa ser o ÚLTIMO teste do arquivo — ele fecha a aplicação.
  it('encerramento gracioso (Fase 3B): fechar a aplicação com um envio em andamento espera o job terminar — nada é cortado nem repetido', async () => {
    const marker = randomUUID();
    scriptedResponses.set(marker, [{ ...okResponse(`wamid.${marker}`), delayMs: 1500 }, okResponse('nunca-usada')]);
    const data = jobData(tenantA.tenantId, marker);

    await app.get(MessageQueueProducer).enqueue(data);
    // Espera o worker já estar no meio do envio (chamada à Meta em andamento).
    for (let attempt = 0; attempt < 100 && callsFor(marker).length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(callsFor(marker)).toHaveLength(1);

    // É isto que o SIGTERM dispara em produção (enableShutdownHooks em main.ts).
    const closeStartedAt = Date.now();
    await app.close();
    appClosed = true;
    const closeTookMs = Date.now() - closeStartedAt;

    // O fechamento esperou o envio (a Meta simulada leva 1,5 s para responder).
    expect(closeTookMs).toBeGreaterThanOrEqual(1000);

    const job = await queue.getJob(data.idempotencyKey);
    expect(await job?.getState()).toBe('completed');
    expect(job?.attemptsMade).toBe(1);
    expect(callsFor(marker)).toHaveLength(1);
    expect(await fixturePrisma.messageLog.count({ where: { idempotencyKey: data.idempotencyKey } })).toBe(1);
    expect((await queue.getWorkers()).length).toBe(0);
  }, 20000);
});
