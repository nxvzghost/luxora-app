import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

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
    const res = await postSigned(inboundMessagePayload(`wamid.${randomUUID()}`, patient.phone, 'Oi, sou eu'));
    expect(res.status).toBe(200);

    const conversation = await fixturePrisma.conversation.findUniqueOrThrow({
      where: { tenantId_phoneNumber: { tenantId: fixture.tenantId, phoneNumber: patient.phone } },
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

  it('mensagem que não é texto (imagem): 200, ignorada — nenhuma Conversation nem Message', async () => {
    const from = metaPhone();
    const wamid = `wamid.${randomUUID()}`;

    const res = await postSigned(
      metaEnvelope({
        contacts: [{ profile: { name: 'Pessoa Fictícia' }, wa_id: from }],
        messages: [{ from, id: wamid, timestamp: unixNow(), type: 'image', image: { mime_type: 'image/jpeg', sha256: 'ficticio', id: '1' } }],
      }),
    );
    expect(res.status).toBe(200);

    expect(await fixturePrisma.conversation.count({ where: { tenantId: fixture.tenantId, phoneNumber: from } })).toBe(0);
    expect(await fixturePrisma.message.count({ where: { externalId: wamid } })).toBe(0);
  });

  /**
   * CARACTERIZAÇÃO de um limite encontrado nesta fase — não é o
   * comportamento desejado. O telefone do paciente é texto livre e
   * `PatientRepository.findByPhone()` compara por igualdade exata; o
   * cadastro feito pelo próprio sistema grava "+55…" (PromoverContatoUseCase),
   * e a Meta envia só dígitos. O paciente já cadastrado não é reconhecido
   * na primeira mensagem. A correção envolve normalizar o telefone do
   * Patient (regra de identidade, com dado já gravado) e está registrada
   * como decisão pendente em docs/04-API/02-Contratos-de-Integracoes-Externas.md.
   * Quando for corrigido, este teste passa a falhar e deve ser invertido.
   */
  it('LIMITE CONHECIDO (decisão pendente): paciente gravado como "+55…" não é reconhecido quando a Meta envia o mesmo número só em dígitos', async () => {
    const digits = metaPhone();
    const patient = await fixturePrisma.patient.create({
      data: { tenantId: fixture.tenantId, name: `Paciente Formato E164 — ${randomUUID()}`, phone: `+${digits}` },
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
    expect(conversation.patientId).toBeNull();
  });
});
