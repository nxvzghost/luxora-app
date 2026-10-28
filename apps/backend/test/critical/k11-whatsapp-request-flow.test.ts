import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, UserRole } from '@prisma/client';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';
import { K11_CONSTRAINTS } from './support/k11-constraints';
import { AI_PROVIDER, AIResponse, ConversationContext, ConversationInput, IAIProvider, IntentResult, UsageMetrics } from '@domain-services/ai/ai-provider';
import { CONTACT_INTENT_CLASSIFIER, ContactIntentClassificationResult, ContactIntentClassifier } from '@domain-services/ai/contact-intent-classifier';
import { addCivilDays, civilDateIn, formatCivilDate } from '@domain/shared/time-zone';
import { PrismaConversationRepository } from '@infrastructure/database/repositories/prisma-conversation.repository';
import { K11_TEXT, describeAppointment, describeSlot } from '@use-cases/appointment/pedido-pelo-whatsapp.textos';
import { TEST_CLINIC_TIME_ZONE, clinicTimeAt } from '../support/clinic-time';

/**
 * [CRÍTICO — K11] Cancelamento e remarcação pelo WhatsApp em duas etapas, no
 * FLUXO QUE DE FATO RODA (ADR-0069; decisões D1 a D8 de 23/10/2026).
 *
 * Cada mensagem entra pelo webhook real (assinatura, guard, controller), vai
 * para a fila real e é processada pelo worker real, contra o PostgreSQL 16
 * com RLS, as restrições do K11 e o papel da aplicação. O que é de mentira, e
 * só isso: o provedor de IA e o classificador de Contact respondem o que o
 * teste manda. Nenhuma chamada à Anthropic é feita: este arquivo prova o que
 * o backend FAZ com cada classificação possível — inclusive as que tentariam
 * forçar uma execução indevida —, não o que o modelo real classificaria
 * (essa validação, paga, continua pendente).
 *
 * Fila e worker num Redis só deste arquivo (db 11). O worker de SAÍDA fica
 * desligado: nada é enviado à Meta; o texto enviado é lido da mensagem de
 * saída gravada na conversa.
 */

const ISOLATED_REDIS_DB = '11';
const APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? '';
const NO_USAGE: UsageMetrics = { inputTokens: 0, outputTokens: 0, costEstimate: 0, latencyMs: 0 };
const SCRIPTED_REPLY = 'Resposta roteirizada do teste — nenhuma IA real foi chamada.';
const TZ = TEST_CLINIC_TIME_ZONE;
const NO_CHARGE_TALK = /cobran|multa|taxa|pagamento|R\$/i;

/** O que a "IA" devolve em interpretIntent neste turno. */
interface Script {
  intent: string;
  entities?: Record<string, unknown>;
  confirmation?: IntentResult['confirmation'];
  requiresEscalation?: boolean;
}

interface Said {
  wamid: string;
  /** O texto que saiu para o paciente (a mensagem de saída gravada na conversa). */
  reply: string;
  intentInput: ConversationInput;
  /** generateResponse foi chamado? No turno do K11 o texto é do backend, e não é. */
  generated: boolean;
}

let app: INestApplication;
let fixturePrisma: PrismaClient;
let fixture: DedicatedFixture;
let phoneNumberId: string;
let adminToken: string;
let therapistToken: string;
let therapistName: string;
let originalRedisUrl: string | undefined;

let currentScript: Script | undefined;
const intentInputs: ConversationInput[] = [];
const responseContexts: ConversationContext[] = [];
const fetchSpy = vi.fn(async () => {
  throw new Error('Este arquivo não pode fazer nenhuma chamada de rede.');
});

const scriptedAi: IAIProvider = {
  async interpretIntent(input: ConversationInput): Promise<IntentResult> {
    if (!currentScript) throw new Error('A IA roteirizada foi chamada fora de um turno do teste.');
    intentInputs.push(input);
    return {
      intent: currentScript.intent,
      confidence: 0.95,
      entities: currentScript.entities ?? {},
      requiresEscalation: currentScript.requiresEscalation ?? false,
      ...(currentScript.confirmation ? { confirmation: currentScript.confirmation } : {}),
      usage: NO_USAGE,
    };
  },
  async generateResponse(context: ConversationContext): Promise<AIResponse> {
    responseContexts.push(context);
    return { message: SCRIPTED_REPLY, usage: NO_USAGE };
  },
};

/** O eixo de identidade não muda nada aqui: quem identifica é o número cadastrado. */
const scriptedClassifier: ContactIntentClassifier = {
  async classify(): Promise<ContactIntentClassificationResult> {
    return { decision: 'IGNORAR', confidence: 0.95, usage: NO_USAGE };
  },
};

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

const sign = (rawBody: string) => `sha256=${createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')}`;
const api = () => request(app.getHttpServer());
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * Espera o despacho. `failed` é marcado a cada tentativa que falha na Fase 1
 * e o retry do BullMQ reclama a entrada de novo: só o cenário de retry tolera
 * esse estado no meio do caminho.
 */
async function waitUntilProcessed(wamid: string, allowRetry = false): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const entry = await fixturePrisma.inboxEntry.findUnique({ where: { channel_externalId: { channel: 'whatsapp', externalId: wamid } } });
    if (entry?.status === 'failed' && !allowRetry) throw new Error(`O worker falhou ao processar ${wamid}: ${entry.lastError}`);
    if (entry?.status === 'dispatched') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`O worker não concluiu o processamento de ${wamid} a tempo.`);
}

/** A mensagem pelo caminho real: webhook assinado → fila → worker. */
async function deliver(from: string, body: string, script: Script, wamid: string, allowRetry = false): Promise<void> {
  const rawBody = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'Perfil Do Zap' }, wa_id: from }],
              messages: [{ id: wamid, from, type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  });
  currentScript = script;
  try {
    const res = await api().post('/api/v1/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(rawBody)).send(rawBody);
    expect(res.status).toBe(200);
    await waitUntilProcessed(wamid, allowRetry);
  } finally {
    currentScript = undefined;
  }
}

async function say(from: string, body: string, script: Script, wamid = `wamid.${randomUUID()}`, allowRetry = false): Promise<Said> {
  const responsesBefore = responseContexts.length;
  await deliver(from, body, script, wamid, allowRetry);
  return { wamid, reply: await lastReply(from), intentInput: intentInputs[intentInputs.length - 1], generated: responseContexts.length > responsesBefore };
}

const conversationOf = (from: string) =>
  fixturePrisma.conversation.findUniqueOrThrow({ where: { tenantId_phoneNumber: { tenantId: fixture.tenantId, phoneNumber: from } } });

async function lastReply(from: string): Promise<string> {
  const conversation = await conversationOf(from);
  const sent = await fixturePrisma.message.findFirstOrThrow({ where: { conversationId: conversation.id, direction: 'saida' }, orderBy: { createdAt: 'desc' } });
  return sent.content;
}

async function registerPatient(name: string, from: string): Promise<string> {
  const patient = await fixturePrisma.patient.create({ data: { tenantId: fixture.tenantId, name, phone: `+${from}`, state: 'Cadastrado' } });
  fixture.patientIds.push(patient.id);
  return patient.id;
}

async function appointmentFor(patientId: string, scheduledAt: Date): Promise<string> {
  const appointment = await fixturePrisma.appointment.create({
    data: { tenantId: fixture.tenantId, patientId, therapistId: fixture.therapistId, scheduledAt, state: 'Reservada' },
  });
  fixture.appointmentIds.push(appointment.id);
  return appointment.id;
}

async function patientWithAppointment(name: string, from: string, scheduledAt: Date) {
  const patientId = await registerPatient(name, from);
  return { patientId, appointmentId: await appointmentFor(patientId, scheduledAt) };
}

const appointmentById = (id: string) => fixturePrisma.appointment.findUniqueOrThrow({ where: { id } });
const outcomeOf = (appointmentId: string) => fixturePrisma.appointmentOutcomeRecord.findUnique({ where: { appointmentId } });
const noticesOf = (appointmentId: string) =>
  fixturePrisma.appointmentNotice.findMany({ where: { appointmentId }, orderBy: [{ receivedAt: 'asc' }, { recordedAt: 'asc' }] });
const notificationTypes = async (entityId: string) =>
  (await fixturePrisma.notification.findMany({ where: { tenantId: fixture.tenantId, entityId }, orderBy: { createdAt: 'asc' } })).map((n) => n.type);
const describeAt = (when: Date) => describeAppointment(when, therapistName, 'presencial', TZ);

/** O dia e a hora, no fuso da clínica, como a IA os extrairia do texto. */
function newSlotEntities(daysAhead: number, hour: number) {
  return { newDate: formatCivilDate(addCivilDays(civilDateIn(new Date(), TZ), daysAhead)), newTime: `${String(hour).padStart(2, '0')}:00` };
}

async function obliterateQueues(): Promise<void> {
  const connection = new IORedis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null });
  for (const name of ['whatsapp-inbound', 'messages']) {
    const queue = new Queue(name, { connection });
    await queue.obliterate({ force: true });
    await queue.close();
  }
  await connection.quit();
}

async function cleanup(): Promise<void> {
  const tenantId = fixture.tenantId;
  await fixturePrisma.inboxEntry.deleteMany({ where: { tenantId } });
  await fixturePrisma.appointmentDecision.deleteMany({ where: { tenantId } });
  await fixturePrisma.appointmentOutcomeRecord.deleteMany({ where: { tenantId } });
  await fixturePrisma.appointmentNotice.deleteMany({ where: { tenantId } });
  const conversations = await fixturePrisma.conversation.findMany({ where: { tenantId }, select: { id: true } });
  await fixturePrisma.message.deleteMany({ where: { conversationId: { in: conversations.map((c) => c.id) } } });
  await fixturePrisma.conversation.deleteMany({ where: { tenantId } });
  await fixturePrisma.contactPatientAssociation.deleteMany({ where: { tenantId } });
  await fixturePrisma.contact.deleteMany({ where: { tenantId } });
  const patients = await fixturePrisma.patient.findMany({ where: { tenantId }, select: { id: true } });
  fixture.patientIds = Array.from(new Set([...fixture.patientIds, ...patients.map((p) => p.id)]));
  await cleanupDedicatedFixture(fixturePrisma, fixture);
}

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchSpy);
  originalRedisUrl = process.env.REDIS_URL;
  const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  redisUrl.pathname = `/${ISOLATED_REDIS_DB}`;
  process.env.REDIS_URL = redisUrl.toString();
  await obliterateQueues();

  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();

  app = await bootstrapTestApp({
    realWhatsAppInboundWorker: true,
    overrides: [
      { provide: AI_PROVIDER, useValue: scriptedAi },
      { provide: CONTACT_INTENT_CLASSIFIER, useValue: scriptedClassifier },
    ],
  });

  fixture = await createDedicatedFixture(fixturePrisma, 'K11FLOW', { withAvailabilityCalendar: true, withActiveSubscription: true });
  phoneNumberId = `pnid-${randomUUID()}`;
  await fixturePrisma.whatsAppIntegration.create({ data: { tenantId: fixture.tenantId, phoneNumberId, accessToken: 'v1:fake:fake:fake', active: true } });
  adminToken = await createDedicatedUserAndLogin(fixturePrisma, app, fixture, 'K11FLOW', UserRole.admin);
  therapistToken = await createDedicatedUserAndLogin(fixturePrisma, app, fixture, 'K11FLOW', UserRole.therapist);
  therapistName = (await fixturePrisma.therapist.findUniqueOrThrow({ where: { id: fixture.therapistId } })).name;
}, 90_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
  if (fixturePrisma) {
    if (fixture) await cleanup();
    await fixturePrisma.$disconnect();
  }
  await obliterateQueues();
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
  vi.unstubAllGlobals();
}, 90_000);

describe('[CRÍTICO — K11] pedido pelo WhatsApp em duas etapas, no fluxo real', () => {
  describe('cancelamento: pedido, pergunta do backend e confirmação em mensagem seguinte', () => {
    const FROM = '552799660001';
    const slot = clinicTimeAt(21, 10);
    let ids: { patientId: string; appointmentId: string };
    let ask: Said;
    let yes: Said;
    let stateAfterAsk: string;

    beforeAll(async () => {
      ids = await patientWithAppointment('Ana Cancela Teste', FROM, slot);
      ask = await say(FROM, 'Quero cancelar minha consulta.', { intent: 'cancelar_consulta' });
      stateAfterAsk = (await appointmentById(ids.appointmentId)).state;
      yes = await say(FROM, 'Sim, pode cancelar.', { intent: 'confirmar_presenca', confirmation: 'confirma' });
    }, 60_000);

    it('o pedido não muda a consulta: o backend registra o pedido e responde com a pergunta, sem generateResponse', async () => {
      expect(stateAfterAsk).toBe('Reservada');
      expect(ask.generated).toBe(false);
      expect(ask.reply).toBe(K11_TEXT.askCancel(describeAt(slot)));
      const [request] = await noticesOf(ids.appointmentId);
      const conversation = await conversationOf(FROM);
      const inbound = await fixturePrisma.message.findUniqueOrThrow({ where: { externalId: ask.wamid } });
      expect([request.awaitsConfirmation, request.requestedAction, request.intent, request.channel, request.recordedByActorType, request.recordedByUserId]).toEqual([
        true,
        'cancelar',
        'pedido_cancelamento',
        'whatsapp',
        'ai_agent',
        null,
      ]);
      expect([request.conversationId, request.messageId, request.receivedAt, request.referenceSource, request.askedScheduledAt]).toEqual([
        conversation.id,
        ask.wamid,
        inbound.createdAt,
        'recebimento_webhook',
        slot,
      ]);
    });

    it('D3 — a IA recebe a consulta por data, horário e profissional, nunca um identificador', () => {
      const context = ask.intentInput.appointmentContext;
      const local = slot.toLocaleString('sv-SE', { timeZone: TZ });
      expect(context?.upcoming).toEqual([{ date: local.slice(0, 10), weekday: expect.any(String), time: local.slice(11, 16), professional: therapistName, modality: 'presencial' }]);
      expect(context?.pendingQuestion).toBeUndefined();
      // O que vira instrução e conversa para o modelo (tenantId e patientId do
      // objeto de entrada ficam no backend: o A-14, em
      // whatsapp-inbound-idempotency.test.ts, prova que não saem para a Anthropic).
      const sent = JSON.stringify([ask.intentInput, yes.intentInput].map(({ appointmentContext, conversationHistory, message }) => ({ appointmentContext, conversationHistory, message })));
      for (const forbidden of [ids.appointmentId, ids.patientId, fixture.therapistId, fixture.tenantId, 'Ana Cancela Teste', FROM.slice(-8)]) {
        expect(sent).not.toContain(forbidden);
      }
    });

    it('a resposta seguinte vai para a IA com a pergunta pendente; o backend cancela e responde', async () => {
      expect(yes.intentInput.appointmentContext?.pendingQuestion).toBe(ask.reply);
      expect(yes.generated).toBe(false);
      expect(yes.reply).toBe(K11_TEXT.cancelled(describeAt(slot)));
      expect((await appointmentById(ids.appointmentId)).state).toBe('Cancelada');
    });

    it('D2 — pedido e resposta são comunicações distintas, ligadas e preservadas', async () => {
      const [request, reply, ...others] = await noticesOf(ids.appointmentId);
      expect(others).toEqual([]);
      expect([reply.confirmsNoticeId, reply.confirmationAnswer, reply.awaitsConfirmation, reply.messageId, reply.conversationId]).toEqual([
        request.id,
        'confirma',
        false,
        yes.wamid,
        request.conversationId,
      ]);
      expect(reply.receivedAt!.getTime()).toBeGreaterThan(request.receivedAt!.getTime());
      expect([request.awaitsConfirmation, request.confirmationAnswer]).toEqual([true, null]);
    });

    it('D1 — o desfecho é da IA, sem usuário, ligado ao pedido e à confirmação', async () => {
      const [request, reply] = await noticesOf(ids.appointmentId);
      const outcome = await outcomeOf(ids.appointmentId);
      expect([outcome?.outcome, outcome?.outcomeRecordedByActorType, outcome?.outcomeRecordedByUserId]).toEqual(['Cancelada', 'ai_agent', null]);
      expect([outcome?.closingNoticeId, outcome?.closingRequestedAction, outcome?.confirmationNoticeId, outcome?.confirmationAnswer]).toEqual([
        request.id,
        'cancelar',
        reply.id,
        'confirma',
      ]);
    });

    it('a auditoria do pedido, da resposta e do cancelamento é toda do ator ai_agent', async () => {
      const [request, reply] = await noticesOf(ids.appointmentId);
      const rows = await fixturePrisma.auditLog.findMany({ where: { tenantId: fixture.tenantId, entityId: { in: [request.id, reply.id, ids.appointmentId] } } });
      expect(rows.filter((row) => row.action === 'ComunicacaoRegistrada').map((row) => row.entityId).sort()).toEqual([request.id, reply.id].sort());
      expect(rows.some((row) => row.action === 'ConsultaCancelada' && row.entityId === ids.appointmentId)).toBe(true);
      expect(new Set(rows.map((row) => row.actorType))).toEqual(new Set(['ai_agent']));
      expect(rows.every((row) => row.userId === null)).toBe(true);
    });

    it('D8 — nada do que foi dito ao paciente fala em cobrança', () => {
      expect(ask.reply).not.toMatch(NO_CHARGE_TALK);
      expect(yes.reply).not.toMatch(NO_CHARGE_TALK);
    });
  });

  describe('confirmação no mesmo turno do pedido', () => {
    const FROM = '552799660002';
    const slot = clinicTimeAt(22, 10);
    let ids: { appointmentId: string };
    let said: Said;

    beforeAll(async () => {
      ids = await patientWithAppointment('Bruno Mesmo Turno Teste', FROM, slot);
      said = await say(FROM, 'Cancela minha consulta, confirmo, sim, pode cancelar.', { intent: 'cancelar_consulta', confirmation: 'confirma' });
    }, 60_000);

    it('não executa nada: só registra o pedido e pergunta', async () => {
      expect(said.reply).toBe(K11_TEXT.askCancel(describeAt(slot)));
      expect((await appointmentById(ids.appointmentId)).state).toBe('Reservada');
      expect(await outcomeOf(ids.appointmentId)).toBeNull();
      expect((await noticesOf(ids.appointmentId)).map((n) => n.awaitsConfirmation)).toEqual([true]);
    });
  });

  describe('remarcação: horário novo conferido no pedido e de novo na confirmação (D5)', () => {
    const FROM = '552799660003';
    const slot = clinicTimeAt(23, 10);
    const newSlot = clinicTimeAt(24, 15);
    let ids: { appointmentId: string };
    let ask: Said;
    let yes: Said;

    beforeAll(async () => {
      ids = await patientWithAppointment('Carla Remarca Teste', FROM, slot);
      ask = await say(FROM, 'Quero remarcar para o dia 24 às 15h.', { intent: 'remarcar_consulta', entities: newSlotEntities(24, 15) });
      yes = await say(FROM, 'Sim.', { intent: 'duvida_geral', confirmation: 'confirma' });
    }, 60_000);

    it('a pergunta traz os dois horários; a confirmação remarca, com o desfecho da IA', async () => {
      expect(ask.reply).toBe(K11_TEXT.askReschedule(describeAt(slot), describeSlot(newSlot, TZ)));
      expect(yes.reply).toBe(K11_TEXT.rescheduled(describeSlot(newSlot, TZ), describeAt(slot)));
      const [request, reply] = await noticesOf(ids.appointmentId);
      expect([request.requestedAction, request.proposedScheduledAt]).toEqual(['remarcar', newSlot]);
      const outcome = await outcomeOf(ids.appointmentId);
      expect([outcome?.outcome, outcome?.outcomeRecordedByActorType, outcome?.closingNoticeId, outcome?.confirmationNoticeId]).toEqual([
        'Remarcada',
        'ai_agent',
        request.id,
        reply.id,
      ]);
    });

    it('a anterior fica Cancelada; a nova nasce Reservada, ligada a ela, no horário confirmado', async () => {
      expect((await appointmentById(ids.appointmentId)).state).toBe('Cancelada');
      const created = await fixturePrisma.appointment.findFirstOrThrow({ where: { rescheduledFromId: ids.appointmentId } });
      expect([created.scheduledAt, created.state, created.therapistId]).toEqual([newSlot, 'Reservada', fixture.therapistId]);
    });
  });

  describe('remarcação com o horário novo ocupado antes da confirmação (D5)', () => {
    const FROM = '552799660004';
    const slot = clinicTimeAt(25, 10);
    const newSlot = clinicTimeAt(26, 15);
    let ids: { appointmentId: string };
    let yes: Said;

    beforeAll(async () => {
      ids = await patientWithAppointment('Davi Horario Ocupado Teste', FROM, slot);
      await say(FROM, 'Quero remarcar para o dia 26 às 15h.', { intent: 'remarcar_consulta', entities: newSlotEntities(26, 15) });
      // Outro paciente ocupa o horário entre a pergunta e a resposta.
      await appointmentFor(fixture.patientId, newSlot);
      yes = await say(FROM, 'Sim.', { intent: 'duvida_geral', confirmation: 'confirma' });
    }, 60_000);

    it('não altera a consulta, diz o horário que continua e avisa a equipe', async () => {
      expect(yes.reply).toBe(K11_TEXT.slotTakenAtConfirmation(describeSlot(newSlot, TZ), describeAt(slot)));
      const appointment = await appointmentById(ids.appointmentId);
      expect([appointment.state, appointment.scheduledAt]).toEqual(['Reservada', slot]);
      expect(await outcomeOf(ids.appointmentId)).toBeNull();
      expect(await fixturePrisma.appointment.count({ where: { rescheduledFromId: ids.appointmentId } })).toBe(0);
      const [request, reply] = await noticesOf(ids.appointmentId);
      expect(reply.confirmationAnswer).toBe('confirma');
      expect(await notificationTypes(request.id)).toEqual(['whatsapp_request_horario_indisponivel']);
    });
  });

  describe('recusa e resposta ambígua', () => {
    const REFUSES = '552799660005';
    const UNSURE = '552799660006';
    let refused: { appointmentId: string };
    let unsure: { appointmentId: string };
    let no: Said;
    let maybe: Said;

    beforeAll(async () => {
      refused = await patientWithAppointment('Elisa Recusa Teste', REFUSES, clinicTimeAt(27, 10));
      unsure = await patientWithAppointment('Fabio Duvida Teste', UNSURE, clinicTimeAt(28, 10));
      await say(REFUSES, 'Quero cancelar.', { intent: 'cancelar_consulta' });
      no = await say(REFUSES, 'Não, deixa como está.', { intent: 'duvida_geral', confirmation: 'recusa' });
      await say(UNSURE, 'Quero cancelar.', { intent: 'cancelar_consulta' });
      maybe = await say(UNSURE, 'Acho que sim, mas talvez eu consiga ir.', { intent: 'duvida_geral', confirmation: 'ambigua' });
    }, 60_000);

    it('recusa: a consulta continua, a resposta fica registrada para a equipe, que é avisada', async () => {
      expect(no.reply).toBe(K11_TEXT.kept(describeAt(clinicTimeAt(27, 10))));
      expect((await appointmentById(refused.appointmentId)).state).toBe('Reservada');
      expect(await outcomeOf(refused.appointmentId)).toBeNull();
      const [request, reply] = await noticesOf(refused.appointmentId);
      expect([reply.confirmationAnswer, reply.reviewStatus]).toEqual(['recusa', 'pendente']);
      expect(await notificationTypes(request.id)).toEqual(['whatsapp_request_recusa']);
    });

    it('ambígua: nada é executado; a conversa vai para a equipe', async () => {
      expect(maybe.reply).toBe(K11_TEXT.unclear());
      expect((await appointmentById(unsure.appointmentId)).state).toBe('Reservada');
      expect(await outcomeOf(unsure.appointmentId)).toBeNull();
      const [request, reply] = await noticesOf(unsure.appointmentId);
      expect(reply.confirmationAnswer).toBe('ambigua');
      expect(await notificationTypes(request.id)).toEqual(['whatsapp_request_ambigua']);
    });
  });

  describe('outro contato dizendo "sim"', () => {
    const OWNER = '552799660007';
    const STRANGER = '552799660077';
    let ids: { appointmentId: string };
    let strangerYes: Said;

    beforeAll(async () => {
      ids = await patientWithAppointment('Gabi Dona da Consulta Teste', OWNER, clinicTimeAt(29, 10));
      await say(OWNER, 'Quero cancelar.', { intent: 'cancelar_consulta' });
      strangerYes = await say(STRANGER, 'Sim, pode cancelar.', { intent: 'confirmar_presenca', confirmation: 'confirma' });
    }, 60_000);

    it('a resposta de outra conversa não é lida como confirmação: nada muda na consulta', async () => {
      expect(strangerYes.intentInput.appointmentContext?.pendingQuestion).toBeUndefined();
      expect((await appointmentById(ids.appointmentId)).state).toBe('Reservada');
      expect(await outcomeOf(ids.appointmentId)).toBeNull();
      expect((await noticesOf(ids.appointmentId)).map((n) => n.awaitsConfirmation)).toEqual([true]);
    });
  });

  describe('identidade alterada entre a pergunta e a resposta (ADR-0063)', () => {
    const FROM = '552799660008';
    let ids: { appointmentId: string };
    let yes: Said;

    beforeAll(async () => {
      ids = await patientWithAppointment('Helena Identidade Teste', FROM, clinicTimeAt(30, 10));
      await say(FROM, 'Quero cancelar.', { intent: 'cancelar_consulta' });
      // Um segundo cadastro com o mesmo número: o número passa a ser de dois pacientes.
      await registerPatient('Igor Mesmo Numero Teste', FROM);
      yes = await say(FROM, 'Sim.', { intent: 'confirmar_presenca', confirmation: 'confirma' });
    }, 60_000);

    it('nada é executado nem registrado como resposta; nenhum paciente vai para a IA; a equipe é avisada', async () => {
      expect(yes.intentInput.patientId).toBeUndefined();
      expect(yes.intentInput.appointmentContext).toBeUndefined();
      expect((await appointmentById(ids.appointmentId)).state).toBe('Reservada');
      expect(await outcomeOf(ids.appointmentId)).toBeNull();
      const notices = await noticesOf(ids.appointmentId);
      expect(notices.map((n) => n.awaitsConfirmation)).toEqual([true]);
      expect(await notificationTypes(notices[0].id)).toEqual(['whatsapp_request_identidade_alterada']);
    });
  });

  describe('confirmação depois do início da consulta', () => {
    const FROM = '552799660009';
    let ids: { appointmentId: string };
    let yes: Said;
    let startsAt: Date;

    beforeAll(async () => {
      startsAt = new Date(Date.now() + 10_000);
      ids = await patientWithAppointment('Julia Atrasada Teste', FROM, startsAt);
      await say(FROM, 'Não vou conseguir ir.', { intent: 'nao_comparecer' });
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, startsAt.getTime() - Date.now() + 500)));
      yes = await say(FROM, 'Sim, pode cancelar.', { intent: 'duvida_geral', confirmation: 'confirma' });
    }, 60_000);

    it('a resposta é registrada como depois do início, nada é executado, e a equipe é avisada (vencido e tardia)', async () => {
      expect(yes.reply).toBe(K11_TEXT.tooLate());
      expect((await appointmentById(ids.appointmentId)).state).toBe('Reservada');
      expect(await outcomeOf(ids.appointmentId)).toBeNull();
      const [request, reply] = await noticesOf(ids.appointmentId);
      expect([request.intent, request.requestedAction, request.timing]).toEqual(['nao_comparecera', 'cancelar', 'sem_limite_configurado']);
      expect([reply.confirmationAnswer, reply.timing, reply.reviewStatus]).toEqual(['confirma', 'depois_do_inicio', 'pendente']);
      expect(await notificationTypes(request.id)).toEqual(['whatsapp_request_vencido', 'whatsapp_request_tardia']);
    });
  });

  describe('consulta remarcada pela equipe entre a pergunta e a resposta (D4)', () => {
    const FROM = '552799660010';
    const slot = clinicTimeAt(31, 10);
    const movedTo = clinicTimeAt(32, 11);
    let ids: { appointmentId: string };
    let yes: Said;

    beforeAll(async () => {
      ids = await patientWithAppointment('Karen Consulta Mudou Teste', FROM, slot);
      await say(FROM, 'Quero cancelar.', { intent: 'cancelar_consulta' });
      const res = await api()
        .patch(`/api/v1/appointments/${ids.appointmentId}/reschedule`)
        .set(as(adminToken))
        .send({ newScheduledAt: movedTo.toISOString(), requestedBy: 'clinica' });
      expect(res.status).toBe(200);
      yes = await say(FROM, 'Sim.', { intent: 'duvida_geral', confirmation: 'confirma' });
    }, 60_000);

    it('a resposta é registrada para revisão, nada é executado e a equipe é avisada', async () => {
      expect(yes.intentInput.appointmentContext?.pendingQuestion).toBe(K11_TEXT.askCancel(describeAt(slot)));
      expect(yes.reply).toBe(K11_TEXT.changed());
      const outcome = await outcomeOf(ids.appointmentId);
      expect([outcome?.outcome, outcome?.outcomeRecordedByActorType]).toEqual(['Remarcada', 'user']);
      const created = await fixturePrisma.appointment.findFirstOrThrow({ where: { rescheduledFromId: ids.appointmentId } });
      expect([created.state, created.scheduledAt]).toEqual(['Reservada', movedTo]);
      expect(await outcomeOf(created.id)).toBeNull();
      const whatsapp = (await noticesOf(ids.appointmentId)).filter((n) => n.channel === 'whatsapp');
      expect(whatsapp.map((n) => [n.awaitsConfirmation, n.confirmationAnswer, n.reviewStatus])).toEqual([
        [true, null, 'sem_revisao_necessaria'],
        [false, 'confirma', 'pendente'],
      ]);
      expect(await notificationTypes(whatsapp[0].id)).toEqual(['whatsapp_request_consulta_alterada']);
    });
  });

  describe('idempotência: confirmação reprocessada pelo worker e reentregue pela Meta', () => {
    const FROM = '552799660011';
    const slot = clinicTimeAt(33, 10);
    let ids: { appointmentId: string };
    let yes: Said;
    let failedOnce = false;

    beforeAll(async () => {
      ids = await patientWithAppointment('Lucas Repetido Teste', FROM, slot);
      await say(FROM, 'Quero cancelar.', { intent: 'cancelar_consulta' });
      // A gravação da resposta de saída falha uma vez, depois de o K11 já ter
      // agido: o BullMQ tenta o job de novo, e o turno roda outra vez.
      const original = PrismaConversationRepository.prototype.appendMessages;
      vi.spyOn(PrismaConversationRepository.prototype, 'appendMessages').mockImplementation(async function (
        this: PrismaConversationRepository,
        ...args: Parameters<PrismaConversationRepository['appendMessages']>
      ) {
        if (!failedOnce && args[0].some((message) => message.direction === 'saida')) {
          failedOnce = true;
          throw new Error('falha simulada ao gravar a resposta de saída');
        }
        return original.apply(this, args);
      });
      yes = await say(FROM, 'Sim.', { intent: 'duvida_geral', confirmation: 'confirma' }, `wamid.${randomUUID()}`, true);
      vi.mocked(PrismaConversationRepository.prototype.appendMessages).mockRestore();
      // A Meta entrega a mesma mensagem de novo (mesmo WAMID).
      await deliver(FROM, 'Sim.', { intent: 'duvida_geral', confirmation: 'confirma' }, yes.wamid);
    }, 60_000);

    it('o turno rodou de novo, e o cancelamento aconteceu uma vez só', async () => {
      expect(failedOnce).toBe(true);
      const inbox = await fixturePrisma.inboxEntry.findUniqueOrThrow({ where: { channel_externalId: { channel: 'whatsapp', externalId: yes.wamid } } });
      expect(inbox.attempts).toBeGreaterThanOrEqual(2);
      expect(yes.reply).toBe(K11_TEXT.cancelled(describeAt(slot)));
      expect((await appointmentById(ids.appointmentId)).state).toBe('Cancelada');
      const notices = await noticesOf(ids.appointmentId);
      expect(notices.map((n) => n.awaitsConfirmation)).toEqual([true, false]);
      const outcome = await outcomeOf(ids.appointmentId);
      expect([outcome?.outcomeRecordedByActorType, outcome?.confirmationNoticeId]).toEqual(['ai_agent', notices[1].id]);
    });

    it('uma resposta de saída só para a confirmação, mesmo com a reentrega', async () => {
      const conversation = await conversationOf(FROM);
      const sent = await fixturePrisma.message.findMany({ where: { conversationId: conversation.id, direction: 'saida' }, orderBy: { createdAt: 'asc' } });
      expect(sent.map((m) => m.content)).toEqual([K11_TEXT.askCancel(describeAt(slot)), K11_TEXT.cancelled(describeAt(slot))]);
    });
  });

  describe('pedido depois do início e "não vou conseguir ir" antes do início (D7)', () => {
    const LATE = '552799660012';
    const EARLY = '552799660013';
    const startedAt = new Date(Date.now() - 30 * 60_000);
    const early = clinicTimeAt(34, 10);
    let late: { appointmentId: string };
    let ahead: { appointmentId: string };
    let afterStart: Said;
    let beforeStart: Said;

    beforeAll(async () => {
      late = await patientWithAppointment('Marina Ja Comecou Teste', LATE, startedAt);
      ahead = await patientWithAppointment('Nina Nao Vai Teste', EARLY, early);
      afterStart = await say(LATE, 'Não vou conseguir ir.', { intent: 'nao_comparecer' });
      beforeStart = await say(EARLY, 'Não vou conseguir ir.', { intent: 'nao_comparecer' });
    }, 60_000);

    it('depois do início: nenhum pedido, nada muda, a equipe é avisada', async () => {
      expect(afterStart.reply).toBe(K11_TEXT.alreadyStarted(describeAt(startedAt)));
      expect(await noticesOf(late.appointmentId)).toEqual([]);
      expect((await appointmentById(late.appointmentId)).state).toBe('Reservada');
      expect(await notificationTypes(late.appointmentId)).toEqual(['whatsapp_request_depois_do_inicio']);
    });

    it('antes do início: é pedido de cancelamento, com a pergunta', async () => {
      expect(beforeStart.reply).toBe(K11_TEXT.askCancel(describeAt(early)));
      const [request] = await noticesOf(ahead.appointmentId);
      expect([request.intent, request.requestedAction]).toEqual(['nao_comparecera', 'cancelar']);
    });
  });

  describe('pendências da equipe: GET /appointments/whatsapp-requests', () => {
    it('sem sessão: 401', async () => {
      expect((await api().get('/api/v1/appointments/whatsapp-requests')).status).toBe(401);
    });

    it('lista o que espera o paciente, o que pede a equipe e o que a IA executou com a confirmação dele', async () => {
      const res = await api().get('/api/v1/appointments/whatsapp-requests').set(as(adminToken));
      expect(res.status).toBe(200);
      const byPatient = new Map<string, string[]>();
      for (const item of res.body.data as Array<{ status: string; appointment: { patientId: string } }>) {
        const patient = await fixturePrisma.patient.findUniqueOrThrow({ where: { id: item.appointment.patientId } });
        byPatient.set(patient.name, [...(byPatient.get(patient.name) ?? []), item.status]);
      }
      expect(Object.fromEntries(byPatient)).toEqual({
        'Ana Cancela Teste': ['confirmado'],
        'Bruno Mesmo Turno Teste': ['aguardando'],
        'Carla Remarca Teste': ['confirmado'],
        'Davi Horario Ocupado Teste': ['nao_executado'],
        'Fabio Duvida Teste': ['encaminhado'],
        'Gabi Dona da Consulta Teste': ['aguardando'],
        'Helena Identidade Teste': ['aguardando'],
        'Julia Atrasada Teste': ['nao_executado'],
        'Lucas Repetido Teste': ['confirmado'],
        'Nina Nao Vai Teste': ['aguardando'],
      });
    });

    it('o perfil terapeuta também vê a lista', async () => {
      expect((await api().get('/api/v1/appointments/whatsapp-requests').set(as(therapistToken))).status).toBe(200);
    });
  });

  describe('guarda do CI: o banco declara o K11 e as restrições dele valem', () => {
    it('as 7 restrições do K11 existem e estão validadas', async () => {
      const rows = await fixturePrisma.$queryRawUnsafe<Array<{ conname: string; convalidated: boolean }>>(
        `SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1::text[])`,
        K11_CONSTRAINTS,
      );
      expect(rows.map((row) => row.conname).sort()).toEqual([...K11_CONSTRAINTS].sort());
      expect(rows.every((row) => row.convalidated)).toBe(true);
    });

    it('o banco exige appointment-ai-confirmation-v1, gravada pela migration do K11', async () => {
      const requirement = await fixturePrisma.deploymentRequirement.findUniqueOrThrow({ where: { capability: 'appointment-ai-confirmation-v1' } });
      expect(requirement.setByMigration).toBe('20261023220000_k11_ai_confirmed_requests');
    });

    it('o desfecho aceita usuário nulo só pela restrição do ator; nenhuma coluna nova é atualizável pelo papel da aplicação', async () => {
      const [column] = await fixturePrisma.$queryRawUnsafe<Array<{ is_nullable: string }>>(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'appointment_outcome' AND column_name = 'outcome_recorded_by_user_id'`,
      );
      expect(column.is_nullable).toBe('YES');
      const updatable = await fixturePrisma.$queryRawUnsafe<Array<{ col: string }>>(
        `SELECT t || '.' || c AS col FROM (VALUES
           ('appointment_outcome', 'outcome_recorded_by_actor_type'), ('appointment_outcome', 'outcome_recorded_by_user_id'),
           ('appointment_outcome', 'closing_requested_action'), ('appointment_outcome', 'confirmation_notice_id'),
           ('appointment_outcome', 'confirmation_answer'), ('appointment_outcome', 'confirmation_notice_timing'),
           ('appointment_notice', 'conversation_id'), ('appointment_notice', 'awaits_confirmation'), ('appointment_notice', 'requested_action'),
           ('appointment_notice', 'asked_scheduled_at'), ('appointment_notice', 'asked_modality'), ('appointment_notice', 'proposed_scheduled_at'),
           ('appointment_notice', 'confirms_notice_id'), ('appointment_notice', 'confirmation_answer')) AS v(t, c)
         WHERE has_column_privilege('luxora_app', 'public.' || t, c, 'UPDATE')`,
      );
      expect(updatable).toEqual([]);
    });
  });
});
