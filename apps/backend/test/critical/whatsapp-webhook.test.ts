import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { UNSUPPORTED_MEDIA_REPLY } from '@use-cases/communication/receber-mensagem-whatsapp.use-case';

/**
 * ADR-0053 (AD-007) — Webhook de entrada do WhatsApp: handshake de
 * verificação, autenticação HMAC-SHA256 sobre o corpo bruto, resolução de
 * Tenant via phoneNumberId (PD-007), idempotência por WAMID.
 *
 * Escopo desta suíte: só a parte SÍNCRONA (o que o handler faz antes de
 * devolver 200) — o processamento de IA/envio real (worker assíncrono)
 * depende de credenciais reais da Meta/Anthropic, fora do alcance deste
 * ambiente (mesma categoria de limitação já documentada para
 * WhatsAppMessageProvider/AnthropicAIProvider — "NÃO TESTADO CONTRA A API
 * REAL"). AD-027 cobre esse caso quando as credenciais reais existirem.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let fixture: DedicatedFixture;
let phoneNumberId: string;

const APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? '';
const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? '';

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

async function cleanupConversationData() {
  // ADR-0054 (AD-036) — ACHADO REAL: um POST assinado com sucesso aqui
  // enfileira um job real na fila 'whatsapp-inbound'. Esta suíte pede o
  // WhatsAppInboundQueueWorker DESLIGADO (bootstrapTestApp() sem
  // `realWhatsAppInboundWorker`, ver support/bootstrap-app.ts) — ela
  // própria nunca processa esse job. Mas a fila é real e compartilhada:
  // se a suíte de AD-036 (a única que liga o worker real) estiver rodando
  // concorrentemente, o worker DELA pode pegar esse job órfão e criar uma
  // linha em inbound_processing_inbox para o Tenant desta fixture, com FK
  // própria — sem apagar isso primeiro, cleanupDedicatedFixture() falha
  // ao apagar o Tenant (só aparece rodando a suíte inteira em paralelo).
  // Repete por até ~3s até estabilizar (nenhuma linha nova encontrada),
  // absorvendo essa corrida sem exigir esperar o BullMQ esvaziar de
  // propósito (reintroduziria acoplamento entre suítes).
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { count } = await fixturePrisma.inboxEntry.deleteMany({ where: { tenantId: fixture.tenantId } });
    if (count === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const conversations = await fixturePrisma.conversation.findMany({ where: { tenantId: fixture.tenantId }, select: { id: true } });
  const conversationIds = conversations.map((c) => c.id);
  if (conversationIds.length > 0) {
    await fixturePrisma.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await fixturePrisma.conversation.deleteMany({ where: { id: { in: conversationIds } } });
  }
  // ADR-0055 (AD-018), Fase 5 — ACHADO REAL: todo POST assinado com sucesso
  // agora também passa por ReconhecerOuCriarContatoUseCase, criando um
  // Contact real (Aggregate independente de Conversation, mas mesma FK de
  // tenant_id). cleanupDedicatedFixture() não conhece a tabela `contact` —
  // sem apagar isso primeiro, o delete do Tenant falhava com
  // "Foreign key constraint violated: contact_tenant_id_fkey". Associação
  // antes do Contact (FK filho antes do pai), mesma disciplina já usada
  // acima para Message/Conversation.
  await fixturePrisma.contactPatientAssociation.deleteMany({ where: { tenantId: fixture.tenantId } });
  await fixturePrisma.contact.deleteMany({ where: { tenantId: fixture.tenantId } });
  await fixturePrisma.whatsAppIntegration.deleteMany({ where: { tenantId: fixture.tenantId } });
}

describe('[AD-007] GET /webhooks/whatsapp — handshake de verificação', () => {
  it('responde o hub.challenge em texto puro quando o verify_token bate', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'desafio-123' });
    expect(res.status).toBe(200);
    expect(res.text).toBe('desafio-123');
  });

  it('rejeita com 403 quando o verify_token não bate', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'token-errado', 'hub.challenge': 'desafio-123' });
    expect(res.status).toBe(403);
  });
});

describe('[AD-007] POST /webhooks/whatsapp — autenticação HMAC', () => {
  it('rejeita com 401 quando o header de assinatura está ausente', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(inboundMessagePayload(`wamid.${randomUUID()}`, '+5541900000001', 'Olá')));
    expect(res.status).toBe(401);
  });

  it('rejeita com 401 quando a assinatura não corresponde ao corpo', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=assinaturainvalida')
      .send(JSON.stringify(inboundMessagePayload(`wamid.${randomUUID()}`, '+5541900000001', 'Olá')));
    expect(res.status).toBe(401);
  });

  it('aceita 200 com assinatura válida', async () => {
    const res = await postSigned(inboundMessagePayload(`wamid.${randomUUID()}`, '+5541900000001', 'Olá'));
    expect(res.status).toBe(200);
  });
});

describe('[AD-007] Resolução de Tenant via phoneNumberId (PD-007)', () => {
  it('ignora silenciosamente um phoneNumberId que não pertence a nenhum Tenant conectado — 200, sem criar Conversation', async () => {
    const res = await postSigned(inboundMessagePayload(`wamid.${randomUUID()}`, '+5541900000002', 'Olá', 'phone-number-id-inexistente'));
    expect(res.status).toBe(200);

    const count = await fixturePrisma.conversation.count({ where: { phoneNumber: '+5541900000002' } });
    expect(count).toBe(0);
  });

  it('mensagem para um phoneNumberId conhecido cria a Conversation sob o Tenant correto', async () => {
    const from = `+554190000${Math.floor(Math.random() * 9000 + 1000)}`;
    const res = await postSigned(inboundMessagePayload(`wamid.${randomUUID()}`, from, 'Quero agendar uma consulta'));
    expect(res.status).toBe(200);

    const conversation = await fixturePrisma.conversation.findUniqueOrThrow({
      where: { tenantId_phoneNumber: { tenantId: fixture.tenantId, phoneNumber: from } },
    });
    expect(conversation.tenantId).toBe(fixture.tenantId);

    const messages = await fixturePrisma.message.findMany({ where: { conversationId: conversation.id } });
    expect(messages).toHaveLength(1);
    expect(messages[0].direction).toBe('entrada');
    expect(messages[0].content).toBe('Quero agendar uma consulta');
  });

  it('número que já corresponde a um Patient cadastrado: Conversation nasce com patientId resolvido', async () => {
    const patient = await fixturePrisma.patient.findUniqueOrThrow({ where: { id: fixture.patientId } });
    // Fase 3B — o telefone da fixture está no formato nacional ("11999999999").
    // Este teste enviava esse mesmo texto como remetente, o que a Meta nunca
    // faz: o remetente chega sempre com o código do país. Passou a usar o
    // formato real e, com isso, cobre também o reconhecimento entre grafias
    // diferentes do mesmo número.
    const from = `55${patient.phone}`;
    const res = await postSigned(inboundMessagePayload(`wamid.${randomUUID()}`, from, 'Oi, sou eu'));
    expect(res.status).toBe(200);

    const conversation = await fixturePrisma.conversation.findUniqueOrThrow({
      where: { tenantId_phoneNumber: { tenantId: fixture.tenantId, phoneNumber: from } },
    });
    expect(conversation.patientId).toBe(fixture.patientId);
  });
});

describe('[AD-007] Idempotência por WAMID', () => {
  it('reentrega do mesmo WAMID nunca cria uma segunda Message', async () => {
    const from = `+554190001${Math.floor(Math.random() * 9000 + 1000)}`;
    const wamid = `wamid.${randomUUID()}`;

    const first = await postSigned(inboundMessagePayload(wamid, from, 'Primeira tentativa'));
    expect(first.status).toBe(200);

    const second = await postSigned(inboundMessagePayload(wamid, from, 'Primeira tentativa'));
    expect(second.status).toBe(200);

    const count = await fixturePrisma.message.count({ where: { externalId: wamid } });
    expect(count).toBe(1);
  });

  it('um único POST com 2 mensagens diferentes do mesmo remetente cria 2 Messages, na mesma Conversation', async () => {
    const from = `+554190002${Math.floor(Math.random() * 9000 + 1000)}`;
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: phoneNumberId },
                messages: [
                  { id: `wamid.${randomUUID()}`, from, type: 'text', text: { body: 'Mensagem 1' } },
                  { id: `wamid.${randomUUID()}`, from, type: 'text', text: { body: 'Mensagem 2' } },
                ],
              },
            },
          ],
        },
      ],
    };

    const res = await postSigned(payload);
    expect(res.status).toBe(200);

    const conversation = await fixturePrisma.conversation.findUniqueOrThrow({
      where: { tenantId_phoneNumber: { tenantId: fixture.tenantId, phoneNumber: from } },
    });
    const messages = await fixturePrisma.message.findMany({ where: { conversationId: conversation.id } });
    expect(messages).toHaveLength(2);
  });
});

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
  fixture = await createDedicatedFixture(fixturePrisma, 'WHATSAPPWEBHOOK');

  phoneNumberId = `pnid-${randomUUID()}`;
  await fixturePrisma.whatsAppIntegration.create({
    data: {
      tenantId: fixture.tenantId,
      phoneNumberId,
      accessToken: 'v1:fake:fake:fake', // nunca usado nesta suíte — só o envio de saída decifraria isto
      active: true,
    },
  });
});

afterAll(async () => {
  await cleanupConversationData();
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await fixturePrisma.$disconnect();
  await app?.close();
});

/**
 * Fase 3 da auditoria — contrato de entrada. Os testes acima usam um corpo
 * mínimo, escrito à mão, com o remetente no formato "+55…". A Meta envia
 * outra coisa: um envelope com `object`, `entry[].id`, `contacts`,
 * `timestamp` e `field`, e o remetente só em dígitos, sem "+". Estes testes
 * usam o formato documentado pela Meta (Cloud API, webhook `messages`), com
 * dados fictícios — nenhuma chamada à Meta acontece.
 */
function metaEnvelope(value: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '100000000000001',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '5541300000000', phone_number_id: phoneNumberId },
              ...value,
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
}

/** DDI + DDD + 9 dígitos, só dígitos — como chega em `messages[].from`. */
function metaPhone(): string {
  return `55419${Math.floor(Math.random() * 90000000 + 10000000)}`;
}

function unixNow(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe('[Fase 3] Payload no formato documentado pela Meta', () => {
  it('mensagem de texto com o envelope completo e remetente só em dígitos: 200, Conversation, Message e Contact criados', async () => {
    const from = metaPhone();
    const wamid = `wamid.${randomUUID()}`;

    const res = await postSigned(
      metaEnvelope({
        contacts: [{ profile: { name: 'Pessoa Fictícia' }, wa_id: from }],
        messages: [{ from, id: wamid, timestamp: unixNow(), text: { body: 'Olá, quero marcar um horário' }, type: 'text' }],
      }),
    );
    expect(res.status).toBe(200);

    const conversation = await fixturePrisma.conversation.findUniqueOrThrow({
      where: { tenantId_phoneNumber: { tenantId: fixture.tenantId, phoneNumber: from } },
    });
    const messages = await fixturePrisma.message.findMany({ where: { conversationId: conversation.id } });
    expect(messages).toHaveLength(1);
    expect(messages[0].externalId).toBe(wamid);
    expect(messages[0].direction).toBe('entrada');

    // Contact guarda o telefone normalizado (E.164), não o valor bruto.
    const contact = await fixturePrisma.contact.findFirst({ where: { tenantId: fixture.tenantId, phoneNumber: `+${from}` } });
    expect(contact).not.toBeNull();
  });

  it('notificação só de status (entregue/lida), sem `messages`: 200 e nada é criado', async () => {
    const recipient = metaPhone();

    const res = await postSigned(
      metaEnvelope({
        statuses: [
          {
            id: `wamid.${randomUUID()}`,
            status: 'delivered',
            timestamp: unixNow(),
            recipient_id: recipient,
            conversation: { id: 'conversa-ficticia', origin: { type: 'service' } },
            pricing: { billable: true, pricing_model: 'CBP', category: 'service' },
          },
        ],
      }),
    );
    expect(res.status).toBe(200);

    expect(await fixturePrisma.conversation.count({ where: { tenantId: fixture.tenantId, phoneNumber: recipient } })).toBe(0);
  });

  /**
   * A-15 (19/10/2026) — até aqui a imagem era descartada sem deixar rastro
   * (este teste afirmava exatamente isso). Agora: nenhuma IA, a mensagem fica
   * na conversa, a clínica recebe um aviso e a pessoa recebe a resposta fixa
   * pedindo que escreva. A fila de saída é real; o worker dela está desligado
   * nesta suíte, então o job é conferido e retirado da fila aqui mesmo.
   */
  it('A-15 — mensagem que não é texto (imagem): 200, sem IA — a pessoa recebe o pedido para escrever e a clínica, um aviso', async () => {
    const from = metaPhone();
    const wamid = `wamid.${randomUUID()}`;
    const payload = metaEnvelope({
      contacts: [{ profile: { name: 'Pessoa Fictícia' }, wa_id: from }],
      messages: [{ from, id: wamid, timestamp: unixNow(), type: 'image', image: { mime_type: 'image/jpeg', sha256: 'ficticio', id: '1' } }],
    });

    const res = await postSigned(payload);
    expect(res.status).toBe(200);
    // Reentrega da Meta do mesmo POST: nada se repete.
    expect((await postSigned(payload)).status).toBe(200);

    const conversation = await fixturePrisma.conversation.findFirst({ where: { tenantId: fixture.tenantId, phoneNumber: from } });
    expect(conversation).not.toBeNull();
    const messages = await fixturePrisma.message.findMany({ where: { conversationId: conversation!.id } });
    expect(messages.filter((m) => m.direction === 'entrada').map((m) => m.externalId)).toEqual([wamid]);
    expect(messages.filter((m) => m.direction === 'saida').map((m) => m.content)).toEqual([UNSUPPORTED_MEDIA_REPLY]);

    const notices = await fixturePrisma.notification.findMany({
      where: { tenantId: fixture.tenantId, type: 'whatsapp_unsupported_media', message: { contains: from.slice(-4) } },
    });
    expect(notices).toHaveLength(1);

    const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    const outbound = new Queue('messages', { connection });
    const inbound = new Queue('whatsapp-inbound', { connection });
    try {
      const job = await outbound.getJob(`unsupported-media-reply-${wamid}`);
      expect(job?.data).toMatchObject({ tenantId: fixture.tenantId, toPhoneNumber: from, body: UNSUPPORTED_MEDIA_REPLY });
      expect(await inbound.getJob(wamid)).toBeUndefined();
      await job?.remove().catch(() => undefined);
    } finally {
      await outbound.close();
      await inbound.close();
      await connection.quit();
    }
  });

  it('A-08 — status "failed" de uma cobrança enviada: o envio passa a falho e a clínica recebe um aviso, uma vez só', async () => {
    const recipient = metaPhone();
    const providerMessageId = `wamid.${randomUUID()}`;
    const billingId = randomUUID();
    const log = await fixturePrisma.messageLog.create({
      data: {
        tenantId: fixture.tenantId,
        toPhoneNumber: recipient,
        body: 'texto da cobrança — nunca vai para o aviso',
        idempotencyKey: `billing-${billingId}`,
        providerMessageId,
      },
    });
    const payload = metaEnvelope({
      statuses: [
        {
          id: providerMessageId,
          status: 'failed',
          timestamp: unixNow(),
          recipient_id: recipient,
          errors: [{ code: 131047, title: 'Re-engagement message', message: 'Re-engagement message' }],
        },
      ],
    });

    try {
      expect((await postSigned(payload)).status).toBe(200);
      expect((await postSigned(payload)).status).toBe(200); // reentrega do mesmo status

      expect((await fixturePrisma.messageLog.findUnique({ where: { id: log.id } }))?.status).toBe('failed');
      const notices = await fixturePrisma.notification.findMany({ where: { tenantId: fixture.tenantId, entityId: billingId } });
      expect(notices).toHaveLength(1);
      expect(notices[0].type).toBe('whatsapp_delivery_failed');
      expect(notices[0].message).toContain(`final ${recipient.slice(-4)}`);
      expect(notices[0].message).toContain('24 horas');
      expect(notices[0].message).not.toContain('texto da cobrança');
    } finally {
      await fixturePrisma.messageLog.delete({ where: { id: log.id } });
    }
  });

  it('A-08 — status "failed" de uma mensagem que não está registrada: 200, nenhum aviso', async () => {
    const before = await fixturePrisma.notification.count({ where: { tenantId: fixture.tenantId, type: 'whatsapp_delivery_failed' } });
    const res = await postSigned(
      metaEnvelope({ statuses: [{ id: `wamid.${randomUUID()}`, status: 'failed', timestamp: unixNow(), recipient_id: metaPhone(), errors: [{ code: 131026 }] }] }),
    );
    expect(res.status).toBe(200);
    expect(await fixturePrisma.notification.count({ where: { tenantId: fixture.tenantId, type: 'whatsapp_delivery_failed' } })).toBe(before);
  });

  /**
   * Fase 3B (ADR-0059) — até aqui o paciente gravado como "+55…" não era
   * reconhecido quando a Meta enviava o mesmo número só em dígitos: a busca
   * comparava o texto exato. A comparação agora é entre formas normalizadas;
   * o telefone gravado continua como foi digitado.
   */
  it.each<[string, (digits: string) => string]>([
    ['"+55…" (como o próprio sistema grava)', (d) => `+${d}`],
    ['com "+", espaços, parênteses e hífen', (d) => `+55 (${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`],
    ['com máscara, sem o código do país', (d) => `(${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`],
    ['só dígitos, sem o código do país', (d) => d.slice(2)],
  ])('paciente gravado %s é reconhecido quando a Meta envia o número só em dígitos', async (_label, stored) => {
    const digits = metaPhone();
    const patient = await fixturePrisma.patient.create({
      data: { tenantId: fixture.tenantId, name: `Paciente telefone — ${randomUUID()}`, phone: stored(digits) },
    });
    fixture.patientIds.push(patient.id);

    const res = await postSigned(
      metaEnvelope({
        contacts: [{ profile: { name: 'Pessoa Fictícia' }, wa_id: digits }],
        messages: [{ from: digits, id: `wamid.${randomUUID()}`, timestamp: unixNow(), text: { body: 'Oi, sou eu' }, type: 'text' }],
      }),
    );
    expect(res.status).toBe(200);

    const conversation = await fixturePrisma.conversation.findUniqueOrThrow({
      where: { tenantId_phoneNumber: { tenantId: fixture.tenantId, phoneNumber: digits } },
    });
    expect(conversation.patientId).toBe(patient.id);
    // Nada gravado foi reescrito.
    expect((await fixturePrisma.patient.findUniqueOrThrow({ where: { id: patient.id } })).phone).toBe(stored(digits));
  });

  describe('A-09 — nono dígito', () => {
    /** Remetente como a Meta envia, COM o 9: 55 + DDD + 9 + linha começando de 6 a 9. */
    function mobileWithNine(): string {
      return `55419${Math.floor(Math.random() * 40000000 + 60000000)}`;
    }
    const withoutNine = (digits: string) => `${digits.slice(0, 4)}${digits.slice(5)}`;

    async function send(from: string) {
      const res = await postSigned(
        metaEnvelope({ messages: [{ from, id: `wamid.${randomUUID()}`, timestamp: unixNow(), text: { body: 'Oi' }, type: 'text' }] }),
      );
      expect(res.status).toBe(200);
    }

    it('paciente cadastrado COM o 9 é reconhecido quando a Meta envia SEM o 9', async () => {
      const digits = mobileWithNine();
      const patient = await fixturePrisma.patient.create({
        data: { tenantId: fixture.tenantId, name: `Paciente nono dígito — ${randomUUID()}`, phone: `+${digits}` },
      });
      fixture.patientIds.push(patient.id);

      await send(withoutNine(digits));

      const conversation = await fixturePrisma.conversation.findUniqueOrThrow({
        where: { tenantId_phoneNumber: { tenantId: fixture.tenantId, phoneNumber: withoutNine(digits) } },
      });
      expect(conversation.patientId).toBe(patient.id);
    });

    it('paciente com cadastro antigo SEM o 9 é reconhecido quando a Meta envia COM o 9', async () => {
      const digits = mobileWithNine();
      const stored = `(${digits.slice(2, 4)}) ${digits.slice(5, 9)}-${digits.slice(9)}`;
      const patient = await fixturePrisma.patient.create({
        data: { tenantId: fixture.tenantId, name: `Paciente nono dígito — ${randomUUID()}`, phone: stored },
      });
      fixture.patientIds.push(patient.id);

      await send(digits);

      const conversation = await fixturePrisma.conversation.findUniqueOrThrow({
        where: { tenantId_phoneNumber: { tenantId: fixture.tenantId, phoneNumber: digits } },
      });
      expect(conversation.patientId).toBe(patient.id);
      expect((await fixturePrisma.patient.findUniqueOrThrow({ where: { id: patient.id } })).phone).toBe(stored);
    });

    it('a mesma pessoa escrevendo com e sem o 9: uma conversa e um contato só', async () => {
      const digits = mobileWithNine();
      await send(digits);
      await send(withoutNine(digits));

      const spellings = [digits, withoutNine(digits), `+${digits}`, `+${withoutNine(digits)}`];
      expect(await fixturePrisma.conversation.count({ where: { tenantId: fixture.tenantId, phoneNumber: { in: spellings } } })).toBe(1);
      expect(await fixturePrisma.contact.count({ where: { tenantId: fixture.tenantId, phoneNumber: { in: spellings } } })).toBe(1);
    });

    it('um paciente com o 9 e outro sem o 9 na mesma linha: ninguém é reconhecido — a conversa vai para a clínica', async () => {
      const digits = mobileWithNine();
      for (const phone of [`+${digits}`, `+${withoutNine(digits)}`]) {
        const patient = await fixturePrisma.patient.create({
          data: { tenantId: fixture.tenantId, name: `Paciente nono dígito — ${randomUUID()}`, phone },
        });
        fixture.patientIds.push(patient.id);
      }

      await send(digits);

      const conversation = await fixturePrisma.conversation.findUniqueOrThrow({
        where: { tenantId_phoneNumber: { tenantId: fixture.tenantId, phoneNumber: digits } },
      });
      expect(conversation.patientId).toBeNull();
    });
  });

  it('paciente com o mesmo telefone cadastrado em OUTRA clínica não é reconhecido', async () => {
    const other = await createDedicatedFixture(fixturePrisma, 'WHATSAPPWEBHOOKOUTRA');
    try {
      const digits = metaPhone();
      const patientOfOther = await fixturePrisma.patient.create({
        data: { tenantId: other.tenantId, name: `Paciente de outra clínica — ${randomUUID()}`, phone: `+${digits}` },
      });
      other.patientIds.push(patientOfOther.id);

      const res = await postSigned(
        metaEnvelope({
          messages: [{ from: digits, id: `wamid.${randomUUID()}`, timestamp: unixNow(), text: { body: 'Olá' }, type: 'text' }],
        }),
      );
      expect(res.status).toBe(200);

      const conversation = await fixturePrisma.conversation.findUniqueOrThrow({
        where: { tenantId_phoneNumber: { tenantId: fixture.tenantId, phoneNumber: digits } },
      });
      expect(conversation.patientId).toBeNull();
    } finally {
      await cleanupDedicatedFixture(fixturePrisma, other);
    }
  });

  it('a mesma pessoa com o número em outra grafia não abre uma segunda conversa', async () => {
    const digits = metaPhone();

    // Conversa antiga, gravada com "+" (como os registros de teste e de carga inicial).
    expect((await postSigned(inboundMessagePayload(`wamid.${randomUUID()}`, `+${digits}`, 'Primeira mensagem'))).status).toBe(200);
    // A Meta envia o mesmo número só em dígitos.
    expect(
      (
        await postSigned(
          metaEnvelope({
            messages: [{ from: digits, id: `wamid.${randomUUID()}`, timestamp: unixNow(), text: { body: 'Segunda mensagem' }, type: 'text' }],
          }),
        )
      ).status,
    ).toBe(200);

    const conversations = await fixturePrisma.conversation.findMany({
      where: { tenantId: fixture.tenantId, phoneNumber: { in: [digits, `+${digits}`] } },
    });
    expect(conversations).toHaveLength(1);
    expect(await fixturePrisma.message.count({ where: { conversationId: conversations[0].id } })).toBe(2);
    expect(await fixturePrisma.contact.count({ where: { tenantId: fixture.tenantId, phoneNumber: `+${digits}` } })).toBe(1);
  });

  it('remetente de outro país: 200, ignorado; a mensagem seguinte do mesmo POST é processada', async () => {
    // Celular do Peru: os mesmos dígitos de um celular de Porto Alegre escrito sem o 55.
    const foreign = `519${Math.floor(Math.random() * 90000000 + 10000000)}`;
    const brazilian = metaPhone();
    const foreignWamid = `wamid.${randomUUID()}`;
    const brazilianWamid = `wamid.${randomUUID()}`;

    const res = await postSigned(
      metaEnvelope({
        messages: [
          { from: foreign, id: foreignWamid, timestamp: unixNow(), text: { body: 'Hola' }, type: 'text' },
          { from: brazilian, id: brazilianWamid, timestamp: unixNow(), text: { body: 'Olá' }, type: 'text' },
        ],
      }),
    );
    // Antes da Fase 3B a resposta era 500, e a Meta reenviaria o POST inteiro.
    expect(res.status).toBe(200);

    expect(await fixturePrisma.conversation.count({ where: { tenantId: fixture.tenantId, phoneNumber: foreign } })).toBe(0);
    expect(await fixturePrisma.message.count({ where: { externalId: foreignWamid } })).toBe(0);
    expect(await fixturePrisma.contact.count({ where: { tenantId: fixture.tenantId, phoneNumber: `+55${foreign}` } })).toBe(0);
    expect(await fixturePrisma.message.count({ where: { externalId: brazilianWamid } })).toBe(1);
  });
});
