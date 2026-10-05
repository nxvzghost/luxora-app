import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { DedicatedFixture } from '../critical/support/dedicated-fixture';
import { MessageJobData, MessageQueueProducer } from '@infrastructure/messaging/message-queue.producer';
import { MessageQueueWorker } from '@infrastructure/messaging/message-queue.worker';
import { TokenCipherService } from '@shared/token-cipher.service';
import { loadBackendEnv, logSmoke } from './support/smoke-env';

/**
 * [MANUAL / EXTERNAL] A fila de saída inteira contra a Meta de verdade:
 *
 *   MessageQueueProducer → Redis → MessageQueueWorker → EnviarMensagemUseCase
 *   → WhatsAppMessageProvider → Graph API
 *
 * Nada é interceptado: o `fetch` é o real (só contado). É a mesma cadeia de
 * test/critical/whatsapp-outbound-worker.test.ts, que simula a Meta.
 *
 * Só roda com EXTERNAL_SMOKE=1. Precisa do Postgres e do Redis locais
 * (docker compose) e usa um banco lógico próprio do Redis (índice 15) —
 * nunca o banco padrão, onde `pnpm dev` trabalha. Cria clínicas
 * descartáveis e as apaga ao final.
 *
 * Sempre: clínica com um token INVÁLIDO de propósito — a Meta recusa, o job
 * encerra na 1ª tentativa. Não exige credencial e não entrega nada.
 *
 * Com WHATSAPP_SMOKE_PHONE_NUMBER_ID, WHATSAPP_SMOKE_ACCESS_TOKEN e
 * WHATSAPP_SMOKE_TO definidos (número de teste do App da Meta e um
 * destinatário autorizado — o seu próprio número, nunca um paciente):
 * envia UMA mensagem pela fila, confere o registro e a idempotência.
 * Ver test/manual/README.md.
 */
loadBackendEnv();

const enabled = process.env.EXTERNAL_SMOKE === '1';
const smokePhoneNumberId = process.env.WHATSAPP_SMOKE_PHONE_NUMBER_ID;
const smokeAccessToken = process.env.WHATSAPP_SMOKE_ACCESS_TOKEN;
const smokeTo = process.env.WHATSAPP_SMOKE_TO;
const hasRealChannel = Boolean(smokePhoneNumberId && smokeAccessToken && smokeTo);

const ISOLATED_REDIS_DB = '15';
const INVALID_TOKEN = 'token-invalido-de-proposito';

let app: INestApplication;
let fixturePrisma: PrismaClient;
let queueConnection: IORedis;
let queue: Queue<MessageJobData>;
let originalRedisUrl: string | undefined;
let cleanupFixture: (prisma: PrismaClient, fixture: DedicatedFixture) => Promise<void>;

let tenantInvalidToken: DedicatedFixture;
let tenantNoChannel: DedicatedFixture;
let tenantRealChannel: DedicatedFixture | undefined;

const realFetch = globalThis.fetch;
const fetchSpy = vi.fn((...args: Parameters<typeof fetch>) => realFetch(...args));

/** Chamadas feitas à Graph API cujo corpo contém o marcador (texto único da mensagem de teste). */
function graphCallsFor(marker: string) {
  return fetchSpy.mock.calls.filter(
    ([url, init]) => String(url).startsWith('https://graph.facebook.com/') && String(init?.body ?? '').includes(marker),
  );
}

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

async function waitForFinalState(jobId: string, timeoutMs = 40000): Promise<'completed' | 'failed'> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await queue.getJob(jobId);
    const state = job ? await job.getState() : 'unknown';
    if (state === 'completed' || state === 'failed') return state;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timeout esperando o job ${jobId} chegar a um estado final.`);
}

function jobData(tenantId: string, marker: string, toPhoneNumber: string): MessageJobData {
  return {
    tenantId,
    toPhoneNumber,
    body: `[TESTE LUXORA] Validação da fila de saída ${marker}`,
    idempotencyKey: `smoke-fila-${marker}`,
    correlationId: `smoke-fila-${marker}`,
  };
}

describe.skipIf(!enabled)('[MANUAL / EXTERNAL] Fila de saída real → Graph API da Meta', () => {
  beforeAll(async () => {
    originalRedisUrl = process.env.REDIS_URL;
    const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
    redisUrl.pathname = `/${ISOLATED_REDIS_DB}`;
    process.env.REDIS_URL = redisUrl.toString();

    vi.stubGlobal('fetch', fetchSpy);

    fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
    await fixturePrisma.$connect();

    queueConnection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue<MessageJobData>('messages', { connection: queueConnection });
    await queue.obliterate({ force: true });

    // Importados aqui, e não no topo: carregar o AppModule valida o .env, e
    // este arquivo precisa continuar inerte quando é pulado.
    const { bootstrapTestApp } = await import('../critical/support/bootstrap-app');
    const fixtures = await import('../critical/support/dedicated-fixture');
    cleanupFixture = fixtures.cleanupDedicatedFixture;

    app = await bootstrapTestApp({ realMessageQueueWorker: true });

    const tokenCipher = new TokenCipherService();
    tenantInvalidToken = await fixtures.createDedicatedFixture(fixturePrisma, 'SMOKEWAINV');
    tenantNoChannel = await fixtures.createDedicatedFixture(fixturePrisma, 'SMOKEWANOCH');
    await fixturePrisma.whatsAppIntegration.create({
      data: {
        tenantId: tenantInvalidToken.tenantId,
        phoneNumberId: `1000${Date.now()}`,
        accessToken: tokenCipher.encrypt(INVALID_TOKEN),
        active: true,
      },
    });

    if (hasRealChannel) {
      const alreadyConnected = await fixturePrisma.whatsAppIntegration.findUnique({
        where: { phoneNumberId: smokePhoneNumberId as string },
      });
      if (alreadyConnected) {
        throw new Error(
          'O número de teste (WHATSAPP_SMOKE_PHONE_NUMBER_ID) já está conectado a uma clínica no banco local — desconecte-a antes de rodar este teste.',
        );
      }
      tenantRealChannel = await fixtures.createDedicatedFixture(fixturePrisma, 'SMOKEWAREAL');
      await fixturePrisma.whatsAppIntegration.create({
        data: {
          tenantId: tenantRealChannel.tenantId,
          phoneNumberId: smokePhoneNumberId as string,
          accessToken: tokenCipher.encrypt(smokeAccessToken as string),
          active: true,
        },
      });
    }
  }, 60000);

  afterAll(async () => {
    await app?.close();
    if (queue) {
      await queue.obliterate({ force: true });
      await queue.close();
      await queueConnection.quit();
    }

    const fixtures = [tenantInvalidToken, tenantNoChannel, tenantRealChannel].filter(
      (fixture): fixture is DedicatedFixture => Boolean(fixture),
    );
    if (fixturePrisma) {
      const tenantIds = fixtures.map((fixture) => fixture.tenantId);
      await fixturePrisma.messageLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await fixturePrisma.whatsAppIntegration.deleteMany({ where: { tenantId: { in: tenantIds } } });
      for (const fixture of fixtures) {
        await cleanupFixture(fixturePrisma, fixture);
      }
      await fixturePrisma.$disconnect();
    }

    vi.unstubAllGlobals();
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  }, 60000);

  it('o worker real está registrado como consumidor da fila (sem depender de requisição HTTP)', async () => {
    expect(app.get(MessageQueueWorker)).toBeInstanceOf(MessageQueueWorker);
    expect((await queue.getWorkers()).length).toBeGreaterThanOrEqual(1);
  });

  it('token inválido: a Meta recusa de verdade; o job encerra na 1ª tentativa e nada é registrado como enviado', async () => {
    const marker = randomUUID();
    const data = jobData(tenantInvalidToken.tenantId, marker, '5500000000000');

    const start = Date.now();
    await app.get(MessageQueueProducer).enqueue(data);
    expect(await waitForFinalState(data.idempotencyKey)).toBe('failed');

    const job = await queue.getJob(data.idempotencyKey);
    logSmoke('fila→meta', {
      cenario: 'token inválido',
      http: job?.failedReason?.match(/\((\d{3})\)/)?.[1],
      detalhe: job?.failedReason?.split('): ')[1]?.replace(/\s/g, ''),
      tentativas: job?.attemptsMade,
      classificacao: 'PERMANENTE',
      correlation_id: data.correlationId,
      duracao_ms: Date.now() - start,
    });

    expect(graphCallsFor(marker)).toHaveLength(1);
    expect(job?.attemptsMade).toBe(1);
    expect(job?.failedReason).toMatch(/\((400|401)\)/);
    expect(job?.failedReason).toMatch(/code=\d+/);
    expect(job?.failedReason).toMatch(/fbtrace_id=(?!ausente)\S+/);
    expect(job?.failedReason).not.toContain(INVALID_TOKEN);
    expect(job?.failedReason).not.toContain(marker);
    expect(await fixturePrisma.messageLog.count({ where: { idempotencyKey: data.idempotencyKey } })).toBe(0);
  }, 60000);

  it('clínica sem canal: nenhuma chamada à Meta, mesmo com outra clínica conectada no mesmo banco', async () => {
    const marker = randomUUID();
    const data = jobData(tenantNoChannel.tenantId, marker, '5500000000000');

    await app.get(MessageQueueProducer).enqueue(data);
    expect(await waitForFinalState(data.idempotencyKey)).toBe('failed');

    expect(graphCallsFor(marker)).toHaveLength(0);
    expect((await queue.getJob(data.idempotencyKey))?.attemptsMade).toBe(1);
  }, 60000);

  it.skipIf(!hasRealChannel)(
    'canal de teste real: UMA mensagem enviada pela fila, registrada com o id da Meta e nunca repetida',
    async () => {
      const fixture = tenantRealChannel as DedicatedFixture;
      const marker = randomUUID();
      const data = jobData(fixture.tenantId, marker, smokeTo as string);

      const start = Date.now();
      await app.get(MessageQueueProducer).enqueue(data);
      expect(await waitForFinalState(data.idempotencyKey)).toBe('completed');

      const rows = await fixturePrisma.messageLog.findMany({ where: { idempotencyKey: data.idempotencyKey } });
      logSmoke('fila→meta', {
        cenario: 'canal de teste real',
        http: 200,
        id_mensagem: rows[0]?.providerMessageId ?? undefined,
        correlation_id: data.correlationId,
        duracao_ms: Date.now() - start,
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe(fixture.tenantId);
      expect(rows[0].providerMessageId).toMatch(/^wamid\./);
      expect(graphCallsFor(marker)).toHaveLength(1);

      // Mesmo envio por outro job (outro jobId, mesma chave): barrado por
      // message_log — a Meta não é chamada de novo.
      const otherJobId = `smoke-fila-outro-job-${marker}`;
      await queue.add('send-message', data, { jobId: otherJobId, attempts: 3, backoff: { type: 'exponential', delay: 2000 } });
      expect(await waitForFinalState(otherJobId)).toBe('completed');

      expect(graphCallsFor(marker)).toHaveLength(1);
      expect(await fixturePrisma.messageLog.count({ where: { idempotencyKey: data.idempotencyKey } })).toBe(1);
    },
    90000,
  );
});
