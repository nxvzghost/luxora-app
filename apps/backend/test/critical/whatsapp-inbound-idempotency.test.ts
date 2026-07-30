import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';
import { MessageQueueProducer } from '@infrastructure/messaging/message-queue.producer';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { TenantContext } from '@shared/tenant-context';
import { PrismaInboxRepository } from '@infrastructure/database/repositories/prisma-inbox.repository';

/**
 * ADR-0054 (AD-036) — Idempotência ponta-a-ponta do processamento
 * assíncrono de WhatsApp. Prova, contra Postgres/Redis/BullMQ reais, o
 * cenário exato que motivou esta AD: uma falha no despacho (Fase 2) DEPOIS
 * da IA já ter sido chamada com sucesso (Fase 1) nunca causa uma segunda
 * chamada à IA num retry do BullMQ — apenas a mocada `fetch` para a
 * Anthropic API é interceptada (mesma categoria de limitação já
 * documentada para AnthropicAIProvider — "NÃO TESTADO CONTRA A API REAL");
 * tudo o mais (Postgres, Redis, BullMQ, ModuleRef/ContextIdFactory,
 * InboxRepository) é real.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let sharedPrismaClientProvider: PrismaClientProvider;
let fixture: DedicatedFixture;
let phoneNumberId: string;

const APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? '';

function sign(rawBody: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')}`;
}

function inboundMessagePayload(msgId: string, from: string, body: string, pnid: string = phoneNumberId) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: pnid },
              messages: [{ id: msgId, from, type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
}

async function postSigned(payload: unknown) {
  const rawBody = JSON.stringify(payload);
  return request(app.getHttpServer())
    .post('/api/v1/webhooks/whatsapp')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sign(rawBody))
    .send(rawBody);
}

/**
 * Distingue as 2 chamadas que ProcessarMensagemUseCase sempre faz por
 * turno (interpretIntent com max_tokens:300, generateResponse com
 * max_tokens:500 — ver anthropic-ai.provider.ts). requiresEscalation:true
 * força o intent a nunca tocar IntentActionRouter — fora do escopo desta
 * AD, já coberto pelos testes de AD-007/AD-010/AD-010.
 */
function mockAnthropicFetch() {
  return vi.fn(async (_url: string, opts: { body: string }) => {
    const body = JSON.parse(opts.body) as { max_tokens: number };
    if (body.max_tokens === 300) {
      return {
        ok: true,
        json: async () => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                intent: 'duvida_geral',
                confidence: 0.4,
                entities: {},
                requiresEscalation: true,
                escalationReason: 'teste AD-036',
              }),
            },
          ],
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'Resposta gerada pela IA (mock) — turno único, AD-036.' }],
        usage: { input_tokens: 20, output_tokens: 30 },
      }),
    };
  });
}

// 'failed' não entra no ranking — é tratado à parte (deixa o teste falhar
// com uma mensagem clara em vez de estourar por timeout sem explicação).
const STATUS_RANK: Record<string, number> = { processing: 0, generated: 1, dispatched: 2 };

/**
 * Espera o registro alcançar PELO MENOS `minStatus` — nunca uma igualdade
 * exata. Sob a suíte crítica inteira rodando em paralelo (várias dezenas
 * de arquivos concorrentes no mesmo Postgres/Redis reais), a transição
 * 'generated' pode acontecer rápido demais para esta função pegá-la antes
 * de já ter virado 'dispatched' — uma checagem de igualdade estrita
 * perderia a janela e estouraria por timeout mesmo com tudo funcionando
 * corretamente. Comparar por rank é imune a essa corrida.
 */
async function waitForInboxStatusAtLeast(
  externalId: string,
  minStatus: keyof typeof STATUS_RANK,
  timeoutMs = 15000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await fixturePrisma.inboxEntry.findUnique({
      where: { channel_externalId: { channel: 'whatsapp', externalId } },
    });
    if (row && (row.status === 'failed' || STATUS_RANK[row.status] >= STATUS_RANK[minStatus])) {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timeout esperando InboxEntry(${externalId}) alcançar ao menos '${minStatus}'.`);
}

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

async function cleanupInboundData() {
  await fixturePrisma.inboxEntry.deleteMany({ where: { tenantId: fixture.tenantId } });
  const conversations = await fixturePrisma.conversation.findMany({
    where: { tenantId: fixture.tenantId },
    select: { id: true },
  });
  const conversationIds = conversations.map((c) => c.id);
  if (conversationIds.length > 0) {
    await fixturePrisma.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await fixturePrisma.conversation.deleteMany({ where: { id: { in: conversationIds } } });
  }
  await fixturePrisma.whatsAppIntegration.deleteMany({ where: { tenantId: fixture.tenantId } });
}

beforeAll(async () => {
  // AnthropicAIProvider.callApi() recusa rodar sem ANTHROPIC_API_KEY, mesmo
  // com `fetch` mockado (checa antes de chamar) — .env local mantém a
  // variável vazia de propósito (nunca chama a API real, ver
  // anthropic-ai.provider.ts). Esta suíte é a primeira a exercitar o
  // worker assíncrono de verdade (as demais suítes críticas de WhatsApp
  // escopam-se deliberadamente à parte síncrona do webhook, por esta
  // mesma limitação) — precisa de um valor não-vazio só para passar da
  // checagem; nunca sai da máquina, pois fetch está interceptado.
  process.env.ANTHROPIC_API_KEY = 'test-key-fetch-mockado-nunca-sai-da-maquina';

  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();

  sharedPrismaClientProvider = new PrismaClientProvider();
  await sharedPrismaClientProvider.$connect();

  // ACHADO REAL: 'whatsapp-inbound' é uma fila real no Redis, persistente
  // ENTRE execuções — um job que não chegou a um estado terminal numa
  // execução anterior desta mesma suíte (ex: interrompida por um restart
  // do container, ou rodada antes de nenhum worker estar realmente
  // consumindo a fila) fica esperando indefinidamente. Precisa ser
  // limpa ANTES do worker real desta suíte subir (bootstrapTestApp logo
  // abaixo) — senão ele mesmo consome esse lixo como se fosse trabalho
  // novo, inflando as chamadas mockadas de `fetch` que os testes contam.
  const queueCleanupConnection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  const queueCleanup = new Queue('whatsapp-inbound', { connection: queueCleanupConnection });
  await queueCleanup.obliterate({ force: true });
  await queueCleanup.close();
  await queueCleanupConnection.quit();

  // ADR-0054 (AD-036) — pede o worker real explicitamente: esta é a única
  // suíte crítica que precisa exercitar WhatsAppInboundQueueWorker de
  // verdade. Por padrão bootstrapTestApp() desliga esse worker (ver
  // BootstrapTestAppOptions) justamente para que nenhum outro arquivo da
  // suíte compita pelos mesmos jobs da fila 'whatsapp-inbound' real.
  app = await bootstrapTestApp({ realWhatsAppInboundWorker: true });
  fixture = await createDedicatedFixture(fixturePrisma, 'WAINBOX');

  phoneNumberId = `pnid-${randomUUID()}`;
  await fixturePrisma.whatsAppIntegration.create({
    data: { tenantId: fixture.tenantId, phoneNumberId, accessToken: 'v1:fake:fake:fake', active: true },
  });
});

afterAll(async () => {
  await cleanupInboundData();
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await sharedPrismaClientProvider.$disconnect();
  await fixturePrisma.$disconnect();
  await app?.close();
  process.env.ANTHROPIC_API_KEY = '';
});

describe('[AD-036] Idempotência ponta-a-ponta do processamento assíncrono (ADR-0054)', () => {
  it(
    'retry do BullMQ após falha no despacho nunca rechama a IA nem duplica Message de saída',
    async () => {
      const fetchMock = mockAnthropicFetch();
      vi.stubGlobal('fetch', fetchMock);

      const producer = app.get(MessageQueueProducer);
      const originalEnqueue = producer.enqueue.bind(producer);
      const enqueueSpy = vi
        .spyOn(producer, 'enqueue')
        .mockImplementationOnce(async () => {
          throw new Error('Redis indisponível (simulado) — força o retry do BullMQ');
        })
        .mockImplementation(originalEnqueue);

      try {
        const from = `+554199${Math.floor(Math.random() * 900000 + 100000)}`;
        const wamid = `wamid.${randomUUID()}`;
        // Marcador único embutido no texto da mensagem — necessário porque
        // `fetch` está mockado GLOBALMENTE para o processo, e esta é a
        // única suíte crítica com um WhatsAppInboundQueueWorker real: ela
        // acaba processando também jobs concorrentes genuínos de
        // whatsapp-webhook.test.ts (que roda em paralelo e continua
        // enfileirando de verdade, mesmo com o worker DELA desligado por
        // padrão — só o enqueue continua real). Contar
        // `fetchMock.mock.calls.length` cru misturaria chamadas de jobs
        // completamente alheios a este teste; filtrar pelo marcador único
        // isola exatamente as chamadas geradas por ESTE WAMID.
        const messageText = `AD-036 teste idempotência ${wamid}`;

        const res = await postSigned(inboundMessagePayload(wamid, from, messageText));
        expect(res.status).toBe(200);

        const myFetchCalls = () =>
          fetchMock.mock.calls.filter(([, opts]) => (opts as { body: string }).body.includes(wamid));

        // Marco 1: a Fase 1 (IA + persistência + auditoria) concluiu.
        // `bootstrapTestApp({ realWhatsAppInboundWorker: true })` garante
        // que este é o único worker real da fila 'whatsapp-inbound' em
        // toda a suíte crítica (ver bootstrap-app.ts) — não há mais
        // nenhum outro worker concorrente que possa processar este job
        // sem os mocks/config desta execução (o que existir de outros
        // arquivos é tráfego concorrente legítimo, filtrado acima).
        const atGenerated = await waitForInboxStatusAtLeast(wamid, 'generated');

        expect(atGenerated.status).not.toBe('failed');
        expect(atGenerated.attempts).toBeGreaterThanOrEqual(1);
        expect(atGenerated.attempts).toBeLessThanOrEqual(3); // teto do BullMQ (attempts:3) — nunca laço infinito
        const fetchCallsAtGenerated = myFetchCalls().length;
        expect(fetchCallsAtGenerated).toBeGreaterThan(0);
        expect(fetchCallsAtGenerated % 2).toBe(0); // sempre em pares: interpretIntent + generateResponse

        // Marco 2 (a prova central desta AD): entre 'generated' e
        // 'dispatched', NENHUMA chamada nova à IA — para ESTE WAMID —
        // pode acontecer, mesmo com o despacho forçado a falhar uma vez
        // (enqueueSpy) e depender de um retry real do BullMQ para completar.
        const atDispatched = await waitForInboxStatusAtLeast(wamid, 'dispatched');
        expect(atDispatched.status).toBe('dispatched');
        expect(atDispatched.processedAt).not.toBeNull();
        expect(atDispatched.dispatchedAt).not.toBeNull();
        expect(myFetchCalls().length).toBe(fetchCallsAtGenerated);

        // A falha simulada + pelo menos 1 sucesso real do despacho.
        expect(enqueueSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

        const conversation = await fixturePrisma.conversation.findUniqueOrThrow({
          where: { tenantId_phoneNumber: { tenantId: fixture.tenantId, phoneNumber: from } },
        });
        const outboundMessages = await fixturePrisma.message.findMany({
          where: { conversationId: conversation.id, direction: 'saida' },
        });
        expect(outboundMessages).toHaveLength(1);
      } finally {
        enqueueSpy.mockRestore();
        vi.unstubAllGlobals();
      }
    },
    35000,
  );

  it('índice único (channel, externalId) recusa fisicamente uma segunda entrada para o mesmo evento', async () => {
    const externalId = `wamid.${randomUUID()}`;
    await fixturePrisma.inboxEntry.create({
      data: { tenantId: fixture.tenantId, channel: 'whatsapp', externalId, conversationId: randomUUID() },
    });

    await expect(
      fixturePrisma.inboxEntry.create({
        data: { tenantId: fixture.tenantId, channel: 'whatsapp', externalId, conversationId: randomUUID() },
      }),
    ).rejects.toThrow();

    await fixturePrisma.inboxEntry.deleteMany({ where: { tenantId: fixture.tenantId, externalId } });
  });

  it('claim de staleness: um registro "processing" órfão (claimedAt expirado) é reclamado com sucesso', async () => {
    const externalId = `wamid.${randomUUID()}`;
    const conversationId = randomUUID();
    const staleClaimedAt = new Date(Date.now() - 10 * 60_000); // 10 min — acima do default de 5 min

    await fixturePrisma.inboxEntry.create({
      data: {
        tenantId: fixture.tenantId,
        channel: 'whatsapp',
        externalId,
        conversationId,
        status: 'processing',
        claimedAt: staleClaimedAt,
      },
    });

    const tenantContext = new TenantContext();
    tenantContext.set(fixture.tenantId, null);
    const prismaService = new PrismaService(sharedPrismaClientProvider, tenantContext);
    const repo = new PrismaInboxRepository(prismaService);

    const claim = await repo.tryClaim({ channel: 'whatsapp', externalId, tenantId: fixture.tenantId, conversationId });
    expect(claim.outcome).toBe('claimed');

    const row = await fixturePrisma.inboxEntry.findUniqueOrThrow({
      where: { channel_externalId: { channel: 'whatsapp', externalId } },
    });
    expect(row.attempts).toBe(2);
    expect(row.status).toBe('processing');

    await fixturePrisma.inboxEntry.deleteMany({ where: { tenantId: fixture.tenantId, externalId } });
  });

  it('claim de um registro "processing" ainda fresco resulta em in_progress — nunca processamento concorrente', async () => {
    const externalId = `wamid.${randomUUID()}`;
    const conversationId = randomUUID();

    await fixturePrisma.inboxEntry.create({
      data: { tenantId: fixture.tenantId, channel: 'whatsapp', externalId, conversationId, status: 'processing' },
    });

    const tenantContext = new TenantContext();
    tenantContext.set(fixture.tenantId, null);
    const prismaService = new PrismaService(sharedPrismaClientProvider, tenantContext);
    const repo = new PrismaInboxRepository(prismaService);

    const claim = await repo.tryClaim({ channel: 'whatsapp', externalId, tenantId: fixture.tenantId, conversationId });
    expect(claim.outcome).toBe('in_progress');

    await fixturePrisma.inboxEntry.deleteMany({ where: { tenantId: fixture.tenantId, externalId } });
  });

  it('claim de um registro "failed" é reclamado com sucesso (nova tentativa completa da Fase 1)', async () => {
    const externalId = `wamid.${randomUUID()}`;
    const conversationId = randomUUID();

    await fixturePrisma.inboxEntry.create({
      data: {
        tenantId: fixture.tenantId,
        channel: 'whatsapp',
        externalId,
        conversationId,
        status: 'failed',
        lastError: 'falha simulada anterior',
      },
    });

    const tenantContext = new TenantContext();
    tenantContext.set(fixture.tenantId, null);
    const prismaService = new PrismaService(sharedPrismaClientProvider, tenantContext);
    const repo = new PrismaInboxRepository(prismaService);

    const claim = await repo.tryClaim({ channel: 'whatsapp', externalId, tenantId: fixture.tenantId, conversationId });
    expect(claim.outcome).toBe('claimed');

    const row = await fixturePrisma.inboxEntry.findUniqueOrThrow({
      where: { channel_externalId: { channel: 'whatsapp', externalId } },
    });
    expect(row.status).toBe('processing');
    expect(row.lastError).toBeNull();

    await fixturePrisma.inboxEntry.deleteMany({ where: { tenantId: fixture.tenantId, externalId } });
  });

  it('claim de um registro "generated" retorna resume_dispatch com o resultPayload em cache', async () => {
    const externalId = `wamid.${randomUUID()}`;
    const conversationId = randomUUID();
    const resultPayload = { responseMessage: 'resposta em cache', toPhoneNumber: '+5541900000000' };

    await fixturePrisma.inboxEntry.create({
      data: {
        tenantId: fixture.tenantId,
        channel: 'whatsapp',
        externalId,
        conversationId,
        status: 'generated',
        resultPayload,
        processedAt: new Date(),
      },
    });

    const tenantContext = new TenantContext();
    tenantContext.set(fixture.tenantId, null);
    const prismaService = new PrismaService(sharedPrismaClientProvider, tenantContext);
    const repo = new PrismaInboxRepository(prismaService);

    const claim = await repo.tryClaim({ channel: 'whatsapp', externalId, tenantId: fixture.tenantId, conversationId });
    expect(claim).toEqual({ outcome: 'resume_dispatch', resultPayload });

    await fixturePrisma.inboxEntry.deleteMany({ where: { tenantId: fixture.tenantId, externalId } });
  });
});
