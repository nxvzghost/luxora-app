import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, UserRole } from '@prisma/client';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { bootstrapTestApp } from './support/bootstrap-app';
import {
  createDedicatedFixture,
  createDedicatedUserAndLogin,
  cleanupDedicatedFixture,
  DedicatedFixture,
} from './support/dedicated-fixture';
import {
  AI_PROVIDER,
  AIResponse,
  ConversationContext,
  ConversationInput,
  IAIProvider,
  IntentResult,
  UsageMetrics,
} from '@domain-services/ai/ai-provider';
import {
  CONTACT_INTENT_CLASSIFIER,
  ContactIntentClassificationInput,
  ContactIntentClassificationResult,
  ContactIntentClassifier,
  ContactIntentDecision,
} from '@domain-services/ai/contact-intent-classifier';
import { ASK_FULL_NAME, CLINIC_WILL_CONTINUE, askNameConfirmation } from '@use-cases/contact/contact-intent-action-router';

/**
 * Identidade no WhatsApp, no FLUXO QUE DE FATO RODA — ADR-0063 (AD-037 e
 * AD-038), sobre os Cenários 11, 12 e 13 de Contact.
 *
 * Cada mensagem entra pelo webhook real (assinatura, guard, controller), vai
 * para a fila real e é processada pelo worker real (claim, IA, roteadores,
 * gravação, auditoria, despacho para a fila de saída), contra o Postgres com
 * RLS. A aprovação de vínculo é feita pela rota real do painel, com login.
 *
 * O que é de mentira, e só isso: o provedor de IA e o classificador de
 * Contact respondem o que o teste manda. Nenhuma chamada à Anthropic é
 * feita, e este arquivo não prova nada sobre o que o modelo real
 * responderia — prova o que o backend FAZ com cada resposta possível,
 * inclusive as que tentam forçar uma ação indevida.
 *
 * Fila e worker rodam em um Redis só deste arquivo (db 12), para os jobs
 * daqui não se misturarem com os de whatsapp-inbound-idempotency.test.ts
 * (db 13) — mesmo recurso de whatsapp-outbound-worker.test.ts (db 14). O
 * worker de SAÍDA continua desligado: nada é enviado à Meta.
 *
 * Os três comportamentos que estavam registrados como defeito conhecido
 * (contato novo não conseguia se cadastrar; número de dois pacientes agia
 * pelo mais antigo; a ação rodava no turno do pedido de confirmação) foram
 * corrigidos e agora são testes normais, com as mesmas asserções.
 */

const ISOLATED_REDIS_DB = '12';
const APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? '';
const NO_USAGE: UsageMetrics = { inputTokens: 0, outputTokens: 0, costEstimate: 0, latencyMs: 0 };
const SCRIPTED_REPLY = 'Resposta roteirizada do teste — nenhuma IA real foi chamada.';
const SMALL_TALK = { intent: 'duvida_geral', entities: {} };
/** O nome de perfil que o WhatsApp entrega em toda mensagem. Não pode aparecer em cadastro nenhum. */
const PROFILE_NAME = 'Perfil Do Zap Sem Valor';

/** O que a "IA" responde em um turno: a intenção e a decisão sobre o Contact. */
interface Script {
  intent: Pick<IntentResult, 'intent' | 'entities'>;
  decision: ContactIntentDecision;
  patientNameHint?: string;
  explicitConfirmation?: boolean;
}

interface Clinic {
  fixture: DedicatedFixture;
  phoneNumberId: string;
}

interface Turn {
  /** O classificador de Contact foi consultado neste turno? */
  classifierCalled: boolean;
  classifierInput?: ContactIntentClassificationInput;
  /** O que o provedor de IA recebeu para interpretar a mensagem e para responder. */
  intentInput: ConversationInput;
  responseContext: ConversationContext;
  /** As instruções que o backend deixou para a resposta ("[Pergunte…]", "[Informe…]", "[Ação executada…]"). */
  instructions: string[];
}

let app: INestApplication;
let fixturePrisma: PrismaClient;
let clinicA: Clinic;
let clinicB: Clinic;
let adminA: string;
let adminAUserId: string;
let therapistA: string;
let adminB: string;
let originalRedisUrl: string | undefined;

let currentScript: Script | undefined;
const intentInputs: ConversationInput[] = [];
const responseContexts: ConversationContext[] = [];
const classifierInputs: ContactIntentClassificationInput[] = [];
const fetchSpy = vi.fn(async () => {
  throw new Error('Este arquivo não pode fazer nenhuma chamada de rede.');
});

function requireScript(): Script {
  if (!currentScript) {
    throw new Error('A IA roteirizada foi chamada fora de um turno do teste.');
  }
  return currentScript;
}

const scriptedAi: IAIProvider = {
  async interpretIntent(input: ConversationInput): Promise<IntentResult> {
    const script = requireScript();
    intentInputs.push(input);
    return {
      intent: script.intent.intent,
      confidence: 0.95,
      entities: script.intent.entities,
      requiresEscalation: false,
      usage: NO_USAGE,
    };
  },
  async generateResponse(context: ConversationContext): Promise<AIResponse> {
    responseContexts.push(context);
    return { message: SCRIPTED_REPLY, usage: NO_USAGE };
  },
};

const scriptedClassifier: ContactIntentClassifier = {
  async classify(input: ContactIntentClassificationInput): Promise<ContactIntentClassificationResult> {
    const script = requireScript();
    classifierInputs.push(input);
    return {
      decision: script.decision,
      confidence: 0.95,
      patientNameHint: script.patientNameHint,
      explicitConfirmation: script.explicitConfirmation,
      usage: NO_USAGE,
    };
  },
};

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

function sign(rawBody: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')}`;
}

const api = () => request(app.getHttpServer());
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

async function waitUntilProcessed(wamid: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const entry = await fixturePrisma.inboxEntry.findUnique({ where: { channel_externalId: { channel: 'whatsapp', externalId: wamid } } });
    if (entry?.status === 'failed') {
      throw new Error(`O worker falhou ao processar ${wamid}: ${entry.lastError}`);
    }
    if (entry?.status === 'dispatched') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`O worker não concluiu o processamento de ${wamid} a tempo.`);
}

/**
 * Um turno inteiro de conversa, pelo caminho real: webhook assinado → fila →
 * worker → resposta enfileirada para saída. O payload tem o formato da Meta,
 * inclusive o nome de perfil do remetente.
 */
async function turn(from: string, body: string, script: Script, clinic: Clinic = clinicA): Promise<Turn> {
  const wamid = `wamid.${randomUUID()}`;
  const rawBody = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: clinic.phoneNumberId },
              contacts: [{ profile: { name: PROFILE_NAME }, wa_id: from }],
              messages: [{ id: wamid, from, type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  });
  const before = { intents: intentInputs.length, responses: responseContexts.length, classifications: classifierInputs.length };

  currentScript = script;
  try {
    const res = await api()
      .post('/api/v1/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(rawBody))
      .send(rawBody);
    expect(res.status).toBe(200);
    await waitUntilProcessed(wamid);
  } finally {
    currentScript = undefined;
  }

  expect(responseContexts.length).toBe(before.responses + 1);
  const responseContext = responseContexts[responseContexts.length - 1];
  return {
    classifierCalled: classifierInputs.length > before.classifications,
    classifierInput: classifierInputs.length > before.classifications ? classifierInputs[classifierInputs.length - 1] : undefined,
    intentInput: intentInputs[intentInputs.length - 1],
    responseContext,
    instructions: responseContext.conversationHistory
      .filter((message) => message.role === 'assistant' && message.content.startsWith('['))
      .map((message) => message.content),
  };
}

/** Paciente cadastrado pelo painel antes de qualquer conversa. */
async function registerPatient(name: string, phone: string, createdDaysAgo = 1, clinic: Clinic = clinicA): Promise<string> {
  const patient = await fixturePrisma.patient.create({
    data: {
      tenantId: clinic.fixture.tenantId,
      name,
      phone,
      state: 'Cadastrado',
      createdAt: new Date(Date.now() - createdDaysAgo * 24 * 60 * 60 * 1000),
    },
  });
  clinic.fixture.patientIds.push(patient.id);
  return patient.id;
}

/** Horários fixos, em uma clínica que só este arquivo usa: nunca colidem. */
function slotAt(hour: number): Date {
  const slot = new Date();
  slot.setDate(slot.getDate() + 60);
  slot.setHours(hour, 0, 0, 0);
  return slot;
}

function bookingRequest(slot: Date, extraEntities: Record<string, unknown> = {}): Script['intent'] {
  return {
    intent: 'agendar_consulta',
    entities: { therapistId: clinicA.fixture.therapistId, scheduledAt: slot.toISOString(), modality: 'presencial', ...extraEntities },
  };
}

async function existingAppointment(patientId: string, slot: Date) {
  return fixturePrisma.appointment.create({
    data: { tenantId: clinicA.fixture.tenantId, patientId, therapistId: clinicA.fixture.therapistId, scheduledAt: slot, state: 'Reservada' },
  });
}

async function existingBilling(patientId: string) {
  const billing = await fixturePrisma.billing.create({
    data: { tenantId: clinicA.fixture.tenantId, patientId, amount: 321.45, dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
  });
  clinicA.fixture.billingIds.push(billing.id);
  return billing;
}

const patientCount = (clinic: Clinic = clinicA) => fixturePrisma.patient.count({ where: { tenantId: clinic.fixture.tenantId } });

const appointmentsAt = (slot: Date) =>
  fixturePrisma.appointment.findMany({ where: { tenantId: clinicA.fixture.tenantId, scheduledAt: slot } });

const conversationOf = (from: string, clinic: Clinic = clinicA) =>
  fixturePrisma.conversation.findUnique({
    where: { tenantId_phoneNumber: { tenantId: clinic.fixture.tenantId, phoneNumber: from } },
  });

/** O Contact guarda o telefone normalizado ("+55…"); a Meta entrega só os dígitos. */
const contactOf = (from: string, clinic: Clinic = clinicA) =>
  fixturePrisma.contact.findUnique({
    where: { tenantId_phoneNumber: { tenantId: clinic.fixture.tenantId, phoneNumber: `+${from}` } },
    include: { associations: true },
  });

const noticesFor = (contactId: string, type: string) =>
  fixturePrisma.notification.findMany({ where: { tenantId: clinicA.fixture.tenantId, entityId: contactId, type } });

const actionsIn = (instructions: string[]) => instructions.filter((instruction) => instruction.startsWith('[Ação executada:'));

/** O valor das cobranças deste arquivo (321,45), com o separador — um trecho que nenhum identificador contém por acaso. */
const BILLING_AMOUNT = /321[.,]45/;

async function obliterateQueues(): Promise<void> {
  const connection = new IORedis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null });
  for (const name of ['whatsapp-inbound', 'messages']) {
    const queue = new Queue(name, { connection });
    await queue.obliterate({ force: true });
    await queue.close();
  }
  await connection.quit();
}

async function createClinic(label: string, withCalendar: boolean): Promise<Clinic> {
  const fixture = await createDedicatedFixture(fixturePrisma, label, { withAvailabilityCalendar: withCalendar, withActiveSubscription: true });
  const phoneNumberId = `pnid-${randomUUID()}`;
  await fixturePrisma.whatsAppIntegration.create({
    data: { tenantId: fixture.tenantId, phoneNumberId, accessToken: 'v1:fake:fake:fake', active: true },
  });
  return { fixture, phoneNumberId };
}

async function cleanupClinic(clinic: Clinic | undefined): Promise<void> {
  if (!clinic) return;
  const tenantId = clinic.fixture.tenantId;
  await fixturePrisma.inboxEntry.deleteMany({ where: { tenantId } });
  const conversations = await fixturePrisma.conversation.findMany({ where: { tenantId }, select: { id: true } });
  await fixturePrisma.message.deleteMany({ where: { conversationId: { in: conversations.map((conversation) => conversation.id) } } });
  await fixturePrisma.conversation.deleteMany({ where: { tenantId } });
  await fixturePrisma.contactPatientAssociation.deleteMany({ where: { tenantId } });
  await fixturePrisma.contact.deleteMany({ where: { tenantId } });
  // O cadastro feito pelo WhatsApp cria pacientes que o teste não conhece
  // pelo id. Mesma justificativa do audit_log na fixture: o filtro é o id de
  // uma clínica que só este arquivo possui.
  const patients = await fixturePrisma.patient.findMany({ where: { tenantId }, select: { id: true } });
  clinic.fixture.patientIds = Array.from(new Set([...clinic.fixture.patientIds, ...patients.map((patient) => patient.id)]));
  const billings = await fixturePrisma.billing.findMany({ where: { tenantId }, select: { id: true } });
  clinic.fixture.billingIds = Array.from(new Set([...clinic.fixture.billingIds, ...billings.map((billing) => billing.id)]));
  await cleanupDedicatedFixture(fixturePrisma, clinic.fixture);
}

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchSpy);

  originalRedisUrl = process.env.REDIS_URL;
  const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  redisUrl.pathname = `/${ISOLATED_REDIS_DB}`;
  process.env.REDIS_URL = redisUrl.toString();
  // Um job que tenha sobrado de uma execução interrompida não pode ser
  // processado por este worker como se fosse trabalho novo.
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

  clinicA = await createClinic('CONTACTFLOW', true);
  adminA = await createDedicatedUserAndLogin(fixturePrisma, app, clinicA.fixture, 'CONTACTFLOW', UserRole.admin);
  adminAUserId = clinicA.fixture.userId as string;
  therapistA = await createDedicatedUserAndLogin(fixturePrisma, app, clinicA.fixture, 'CONTACTFLOW', UserRole.therapist);

  clinicB = await createClinic('CONTACTFLOWB', false);
  adminB = await createDedicatedUserAndLogin(fixturePrisma, app, clinicB.fixture, 'CONTACTFLOWB', UserRole.admin);
}, 90_000);

afterAll(async () => {
  await app?.close();
  if (fixturePrisma) {
    await cleanupClinic(clinicA);
    await cleanupClinic(clinicB);
    await fixturePrisma.$disconnect();
  }
  await obliterateQueues();
  if (originalRedisUrl === undefined) {
    delete process.env.REDIS_URL;
  } else {
    process.env.REDIS_URL = originalRedisUrl;
  }
  vi.unstubAllGlobals();
}, 90_000);

describe('[Contact] identidade no fluxo real do WhatsApp — ADR-0063 (AD-037, AD-038), Cenários 11, 12 e 13', () => {
  describe('identificação inequívoca — paciente cadastrado, sozinho no número', () => {
    const FROM = '5541988880001';
    const slot = slotAt(9);
    let patientId: string;
    let patientsBefore: number;
    let patientsAfterBooking: number;
    let patientsAfterPromover: number;
    let booking: Turn;
    let registration: Turn;

    beforeAll(async () => {
      patientId = await registerPatient('Paciente Sozinho no Número', '+55 (41) 98888-0001');
      patientsBefore = await patientCount();

      booking = await turn(FROM, 'Quero marcar uma consulta.', { intent: bookingRequest(slot), decision: 'IGNORAR' });
      patientsAfterBooking = await patientCount();

      // A IA trata a mensagem como um cadastro novo, com nome e confirmação.
      registration = await turn(FROM, 'Sou Fulano de Tal Teste, confirmo, pode me cadastrar.', {
        intent: SMALL_TALK,
        decision: 'PROMOVER',
        patientNameHint: 'Fulano de Tal Teste',
        explicitConfirmation: true,
      });
      patientsAfterPromover = await patientCount();
    }, 60_000);

    it('a conversa nasce ligada ao paciente e o pedido de consulta é atendido para ele, sem pedir nome', async () => {
      expect((await conversationOf(FROM))?.patientId).toBe(patientId);
      expect(booking.responseContext.patientId).toBe(patientId);

      const appointments = await appointmentsAt(slot);
      expect(appointments).toHaveLength(1);
      expect(appointments[0].patientId).toBe(patientId);
      expect(appointments[0].state).toBe('Reservada');
      expect(booking.instructions.some((instruction) => instruction.startsWith('[Ação executada: Consulta agendada'))).toBe(true);
      expect(booking.instructions.some((instruction) => instruction.startsWith('[Pergunte ao paciente:'))).toBe(false);
      expect(patientsAfterBooking).toBe(patientsBefore);
    });

    it('a IA tratar a mensagem como primeiro cadastro não cadastra de novo quem já é paciente (D5b)', async () => {
      expect(patientsAfterPromover).toBe(patientsBefore);
      expect((await conversationOf(FROM))?.patientId).toBe(patientId);
      expect(registration.instructions).toEqual([]);
      expect((await contactOf(FROM))?.name).toBeNull();
    });
  });

  describe('contato novo — nome completo e confirmação explícita antes do cadastro (AD-037)', () => {
    const FROM = '5541988880002';
    const slot = slotAt(10);
    const laterSlot = slotAt(16);
    let patientsBefore: number;
    let firstMessage: Turn;
    let patientsAfterFirstMessage: number;
    let appointmentsAfterFirstMessage: number;
    let nameMessage: Turn;
    let patientsAfterName: number;
    let appointmentsAfterName: number;
    let hesitation: Turn;
    let patientsAfterHesitation: number;
    let patientsAfterConfirmation: number;
    let appointmentsAfterConfirmation: number;
    let followUp: Turn;

    beforeAll(async () => {
      patientsBefore = await patientCount();

      firstMessage = await turn(FROM, 'Oi, quero marcar uma consulta.', {
        intent: bookingRequest(slot),
        decision: 'PROMOVER',
      });
      patientsAfterFirstMessage = await patientCount();
      appointmentsAfterFirstMessage = (await appointmentsAt(slot)).length;

      // A pessoa responde com o nome completo. O roteiro entrega o nome por
      // todos os caminhos que a IA tem para entregá-lo (o texto, o hint do
      // classificador, as entidades da intenção).
      const named: Script = {
        intent: bookingRequest(slot, { patientName: 'Marina Duarte Teste' }),
        decision: 'PROMOVER',
        patientNameHint: 'Marina Duarte Teste',
      };
      nameMessage = await turn(FROM, 'Meu nome completo é Marina Duarte Teste.', named);
      patientsAfterName = await patientCount();
      appointmentsAfterName = (await appointmentsAt(slot)).length;

      // Uma resposta que não confirma nada.
      hesitation = await turn(FROM, 'Deixa eu pensar um pouco.', named);
      patientsAfterHesitation = await patientCount();

      // E confirma, com todas as letras (ADR-0063: nome completo E confirmação
      // explícita antes de criar o cadastro).
      await turn(FROM, 'Sim, confirmo: sou Marina Duarte Teste e quero me cadastrar para marcar a consulta.', {
        ...named,
        explicitConfirmation: true,
      });
      patientsAfterConfirmation = await patientCount();
      appointmentsAfterConfirmation = (await appointmentsAt(slot)).length;

      // Mensagem seguinte, sem assunto de identidade: a pessoa já é paciente.
      followUp = await turn(FROM, 'Quero marcar mais uma.', { intent: bookingRequest(laterSlot), decision: 'IGNORAR' });
    }, 60_000);

    it('sem nome, ninguém é cadastrado e nada é marcado — o fluxo pede o nome', async () => {
      expect(firstMessage.responseContext.patientId).toBeUndefined();
      expect(firstMessage.classifierInput?.contactState).toBe('Conversando');
      expect(firstMessage.classifierInput?.associationCount).toBe(0);
      expect(patientsAfterFirstMessage).toBe(patientsBefore);
      expect(appointmentsAfterFirstMessage).toBe(0);
      expect(firstMessage.instructions).toEqual([`[Pergunte ao paciente: ${ASK_FULL_NAME}]`]);
    });

    it('o contato novo existe uma única vez, por mais mensagens que mande', async () => {
      const tenantId = clinicA.fixture.tenantId;
      expect(await fixturePrisma.contact.count({ where: { tenantId, phoneNumber: `+${FROM}` } })).toBe(1);
      expect(await fixturePrisma.conversation.count({ where: { tenantId, phoneNumber: FROM } })).toBe(1);
    });

    it('só o nome, sem a confirmação explícita, ainda não cadastra ninguém nem marca nada (ADR-0063)', () => {
      expect(patientsAfterName).toBe(patientsBefore);
      expect(appointmentsAfterName).toBe(0);
    });

    it('com o nome informado, o fluxo pede a confirmação com todas as letras', () => {
      expect(nameMessage.instructions).toEqual([`[Pergunte ao paciente: ${askNameConfirmation('Marina Duarte Teste')}]`]);
    });

    it('uma resposta que não confirma não cadastra: a pergunta é feita de novo', () => {
      expect(patientsAfterHesitation).toBe(patientsBefore);
      expect(hesitation.instructions).toEqual([`[Pergunte ao paciente: ${askNameConfirmation('Marina Duarte Teste')}]`]);
    });

    it('[AD-037] depois de informar o nome completo e confirmar, o contato vira paciente e a primeira consulta é marcada', () => {
      expect(patientsAfterConfirmation).toBe(patientsBefore + 1);
      expect(appointmentsAfterConfirmation).toBe(1);
    });

    it('o cadastro leva o nome que a pessoa informou e o número dela — nunca o nome de perfil do WhatsApp', async () => {
      const tenantId = clinicA.fixture.tenantId;
      const created = await fixturePrisma.patient.findMany({ where: { tenantId, phone: `+${FROM}` } });
      expect(created).toHaveLength(1);
      expect(created[0].name).toBe('Marina Duarte Teste');

      const [appointment] = await appointmentsAt(slot);
      expect(appointment.patientId).toBe(created[0].id);

      const contact = await contactOf(FROM);
      expect(contact?.state).toBe('Promovido');
      expect(contact?.name).toBe('Marina Duarte Teste');
      expect(contact?.associations.map((association) => association.patientId)).toEqual([created[0].id]);

      expect(await fixturePrisma.patient.count({ where: { tenantId, name: { contains: 'Perfil' } } })).toBe(0);
      expect(await fixturePrisma.contact.count({ where: { tenantId, name: { contains: 'Perfil' } } })).toBe(0);
    });

    it('depois do cadastro, o número passa a identificar o paciente nas mensagens seguintes', async () => {
      const [created] = await fixturePrisma.patient.findMany({ where: { tenantId: clinicA.fixture.tenantId, phone: `+${FROM}` } });
      const appointments = await appointmentsAt(laterSlot);

      expect(followUp.responseContext.patientId).toBe(created.id);
      expect(appointments.map((appointment) => appointment.patientId)).toEqual([created.id]);
      expect(await patientCount()).toBe(patientsBefore + 1);
    });
  });

  describe('contato novo — nome e "confirmo" na mesma mensagem', () => {
    const FROM = '5541988880007';
    const slot = slotAt(8);
    let patientsBefore: number;
    let rushed: Turn;

    beforeAll(async () => {
      patientsBefore = await patientCount();
      rushed = await turn(FROM, 'Sou Otávio Reis Teste, confirmo, pode cadastrar e marcar.', {
        intent: bookingRequest(slot),
        decision: 'PROMOVER',
        patientNameHint: 'Otávio Reis Teste',
        explicitConfirmation: true,
      });
    }, 60_000);

    it('a confirmação só vale em uma mensagem depois da do nome: nada é cadastrado nem marcado', async () => {
      expect(await patientCount()).toBe(patientsBefore);
      expect(await appointmentsAt(slot)).toHaveLength(0);
      expect((await contactOf(FROM))?.state).toBe('Identificado');
      expect(rushed.instructions).toEqual([`[Pergunte ao paciente: ${askNameConfirmation('Otávio Reis Teste')}]`]);
    });
  });

  describe('Cenário 13 — paciente conhecido escreve de um número novo (AD-038)', () => {
    const OLD_NUMBER = '5541988880003';
    const NEW_NUMBER = '5541988880004';
    const slot = slotAt(11);
    const approvedSlot = slotAt(12);
    let patientId: string;
    let patientsBefore: number;
    let oldContactBefore: Awaited<ReturnType<typeof contactOf>>;
    let claim: Turn;
    let insistence: Turn;
    let selfConfirmation: Turn;

    beforeAll(async () => {
      patientId = await registerPatient('Carla Nunes Teste', '+5541988880003');
      await turn(OLD_NUMBER, 'Bom dia.', { intent: SMALL_TALK, decision: 'IGNORAR' });
      oldContactBefore = await contactOf(OLD_NUMBER);
      patientsBefore = await patientCount();

      // Do número novo, dizendo quem é. A IA entende de duas formas possíveis
      // — "é um paciente que já existe" e "é um cadastro novo" — e nenhuma
      // das duas pode virar vínculo nem cadastro: pela ADR-0063, o número
      // novo só é vinculado depois de a clínica aprovar pelo painel (o que
      // quem escreve disser, por mais que insista, não basta), e quem já é
      // paciente não é cadastrado de novo.
      claim = await turn(NEW_NUMBER, 'Oi, é a Carla Nunes Teste, troquei de número. Quero marcar uma consulta.', {
        intent: bookingRequest(slot),
        decision: 'ASSOCIAR',
        patientNameHint: 'Carla Nunes Teste',
      });
      const asNewPatient: Script = {
        intent: bookingRequest(slot, { patientName: 'Carla Nunes Teste' }),
        decision: 'PROMOVER',
        patientNameHint: 'Carla Nunes Teste',
      };
      insistence = await turn(NEW_NUMBER, 'Sou eu mesma, a Carla Nunes Teste. Pode marcar.', asNewPatient);
      // E confirma, com todas as letras — a confirmação de quem escreve.
      selfConfirmation = await turn(NEW_NUMBER, 'Sim, confirmo, sou a Carla Nunes Teste.', { ...asNewPatient, explicitConfirmation: true });
    }, 60_000);

    describe('antes da aprovação da clínica', () => {
      it('o número novo nunca é ligado ao paciente por conta própria — nem com a confirmação de quem escreve', async () => {
        expect(claim.responseContext.patientId).toBeUndefined();
        expect(selfConfirmation.responseContext.patientId).toBeUndefined();
        expect((await conversationOf(NEW_NUMBER))?.patientId).toBeNull();

        const newContact = await contactOf(NEW_NUMBER);
        expect(newContact?.associations).toHaveLength(0);
        expect(['Conversando', 'Identificado']).toContain(newContact?.state);
        expect(
          await fixturePrisma.contactPatientAssociation.count({ where: { tenantId: clinicA.fixture.tenantId, patientId } }),
        ).toBe(0);
      });

      it('o paciente não é cadastrado de novo e o cadastro dele não muda', async () => {
        expect(await patientCount()).toBe(patientsBefore);
        const patient = await fixturePrisma.patient.findUniqueOrThrow({ where: { id: patientId } });
        expect(patient.phone).toBe('+5541988880003');
        expect(patient.name).toBe('Carla Nunes Teste');
      });

      it('nada é marcado em nome de ninguém antes de a clínica confirmar quem está falando', async () => {
        expect(await appointmentsAt(slot)).toHaveLength(0);
        for (const turnResult of [claim, insistence, selfConfirmation]) {
          expect(actionsIn(turnResult.instructions)).toEqual([]);
        }
      });

      // A frase não diz o motivo nem menciona paciente algum. Ela não esconde o
      // desfecho: um cadastro recusado difere de um aceito, e disso se pode
      // inferir que o nome já existe (limitação registrada na ADR-0063).
      it('a conversa vai para a clínica, e a pessoa ouve só a frase neutra — o motivo não é dito', () => {
        expect(claim.instructions).toEqual([`[Informe ao paciente: ${CLINIC_WILL_CONTINUE}]`]);
        expect(selfConfirmation.instructions).toEqual([`[Informe ao paciente: ${CLINIC_WILL_CONTINUE}]`]);
        expect(CLINIC_WILL_CONTINUE).not.toMatch(/Carla|paciente|cadastro/i);
      });

      it('a clínica é avisada do pedido de vínculo e da possível duplicidade, uma vez cada', async () => {
        const newContact = await contactOf(NEW_NUMBER);
        const linkRequests = await noticesFor(newContact!.id, 'whatsapp_link_request');
        const duplicates = await noticesFor(newContact!.id, 'whatsapp_possible_duplicate');

        expect(linkRequests).toHaveLength(1);
        expect(duplicates).toHaveLength(1);
        expect(linkRequests[0].message).toContain('0004');
        expect(`${linkRequests[0].message} ${duplicates[0].message}`).not.toContain('Carla');
      });

      it('o Contact do número antigo continua como estava — nunca apagado nem alterado', async () => {
        const oldContactAfter = await contactOf(OLD_NUMBER);
        expect(oldContactAfter?.id).toBe(oldContactBefore?.id);
        expect(oldContactAfter?.state).toBe(oldContactBefore?.state);
        expect(oldContactAfter?.phoneNumber).toBe('+5541988880003');
        expect((await conversationOf(OLD_NUMBER))?.patientId).toBe(patientId);
      });
    });

    describe('aprovação do vínculo pela clínica, no painel', () => {
      let contactId: string;

      beforeAll(async () => {
        contactId = (await contactOf(NEW_NUMBER))!.id;
      });

      it('a lista de números aguardando vínculo é só do administrador', async () => {
        expect((await api().get('/api/v1/contacts/pending')).status).toBe(401);
        expect((await api().get('/api/v1/contacts/pending').set(as(therapistA))).status).toBe(403);

        const res = await api().get('/api/v1/contacts/pending').set(as(adminA));
        expect(res.status).toBe(200);
        const pending = res.body.data.find((contact: { id: string }) => contact.id === contactId);
        expect(pending).toMatchObject({ phoneNumber: `+${NEW_NUMBER}`, name: 'Carla Nunes Teste', state: 'Identificado' });
      });

      it('a lista não traz o número que já consta no cadastro de um paciente', async () => {
        const res = await api().get('/api/v1/contacts/pending').set(as(adminA));
        const phones = res.body.data.map((contact: { phoneNumber: string }) => contact.phoneNumber);
        expect(phones).not.toContain(`+${OLD_NUMBER}`);
        expect(phones).not.toContain('+5541988880001');
      });

      it('sem sessão ou com o perfil terapeuta, o vínculo não é feito e nada muda', async () => {
        expect((await api().post(`/api/v1/contacts/${contactId}/link`).send({ patientId })).status).toBe(401);
        expect((await api().post(`/api/v1/contacts/${contactId}/link`).set(as(therapistA)).send({ patientId })).status).toBe(403);

        const contact = await contactOf(NEW_NUMBER);
        expect(contact?.associations).toHaveLength(0);
        expect(contact?.state).toBe('Identificado');
      });

      it('paciente inválido ou inexistente é recusado, e nada muda', async () => {
        expect((await api().post(`/api/v1/contacts/${contactId}/link`).set(as(adminA)).send({})).status).toBe(400);
        expect((await api().post(`/api/v1/contacts/${contactId}/link`).set(as(adminA)).send({ patientId: 'não-é-uuid' })).status).toBe(400);
        expect((await api().post(`/api/v1/contacts/${contactId}/link`).set(as(adminA)).send({ patientId: randomUUID() })).status).toBe(404);
        expect((await api().post(`/api/v1/contacts/${randomUUID()}/link`).set(as(adminA)).send({ patientId })).status).toBe(404);
        expect((await api().post('/api/v1/contacts/não-é-uuid/link').set(as(adminA)).send({ patientId })).status).toBe(400);

        expect((await contactOf(NEW_NUMBER))?.associations).toHaveLength(0);
      });

      it('o administrador aprova: o vínculo passa a existir, com quem aprovou e quando', async () => {
        const before = Date.now();
        const res = await api().post(`/api/v1/contacts/${contactId}/link`).set(as(adminA)).send({ patientId });

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ contactId, patientId, state: 'Vinculado', approvedByUserId: adminAUserId });
        expect(new Date(res.body.approvedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);

        const contact = await contactOf(NEW_NUMBER);
        expect(contact?.state).toBe('Vinculado');
        expect(contact?.associations.map((association) => association.patientId)).toEqual([patientId]);

        // A trilha de auditoria, que não pode ser alterada, guarda o
        // responsável e o horário.
        const entry = await fixturePrisma.auditLog.findFirstOrThrow({
          where: { tenantId: clinicA.fixture.tenantId, action: 'ContatoVinculadoAPacienteExistente', entityId: contactId },
        });
        expect(entry.userId).toBe(adminAUserId);
        expect(entry.actorType).toBe('user');
        expect(entry.payload).toMatchObject({ patientId, approvedByUserId: adminAUserId, approvedAt: res.body.approvedAt });
        expect(entry.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      });

      it('o telefone do cadastro do paciente não é alterado pela aprovação', async () => {
        const patient = await fixturePrisma.patient.findUniqueOrThrow({ where: { id: patientId } });
        expect(patient.phone).toBe('+5541988880003');
      });

      it('aprovar de novo é recusado, e o número sai da lista de pendentes', async () => {
        const again = await api().post(`/api/v1/contacts/${contactId}/link`).set(as(adminA)).send({ patientId });
        expect(again.status).toBe(409);

        const res = await api().get('/api/v1/contacts/pending').set(as(adminA));
        expect(res.body.data.map((contact: { id: string }) => contact.id)).not.toContain(contactId);
        expect((await contactOf(NEW_NUMBER))?.associations).toHaveLength(1);
      });

      it('depois da aprovação, o número novo identifica o paciente e o pedido é atendido para ele', async () => {
        const booked = await turn(NEW_NUMBER, 'Agora quero marcar.', { intent: bookingRequest(approvedSlot), decision: 'IGNORAR' });

        expect(booked.responseContext.patientId).toBe(patientId);
        expect((await appointmentsAt(approvedSlot)).map((appointment) => appointment.patientId)).toEqual([patientId]);
        expect(await patientCount()).toBe(patientsBefore);
      });
    });
  });

  describe('Cenários 11 e 12 — mais de um paciente no mesmo número (AD-038)', () => {
    const FROM = '5541988880005';
    const slot = slotAt(14);
    const existingSlot = slotAt(20);
    let firstRegisteredId: string;
    let secondRegisteredId: string;
    let patientsBefore: number;
    /** Para quem ficou cada consulta marcada no horário pedido. */
    let bookedFor: string[];
    let booking: Turn;
    let naming: Turn;
    let cancelling: Turn;
    let billingQuestion: Turn;
    let appointmentOfFirst: { id: string };

    beforeAll(async () => {
      firstRegisteredId = await registerPatient('Ana Prado Teste', '(41) 98888-0005', 2);
      secondRegisteredId = await registerPatient('Bruno Prado Teste', '(41) 98888-0005', 1);
      patientsBefore = await patientCount();
      appointmentOfFirst = await existingAppointment(firstRegisteredId, existingSlot);
      const billingOfFirst = await existingBilling(firstRegisteredId);

      // Quem escreve é o segundo. A IA não levanta dúvida nenhuma sobre a
      // identidade (IGNORAR) — o que está em jogo é o que o backend faz
      // sozinho quando o número pertence a duas pessoas.
      booking = await turn(FROM, 'Aqui é o Bruno. Quero marcar uma consulta.', { intent: bookingRequest(slot), decision: 'IGNORAR' });
      bookedFor = (await appointmentsAt(slot)).map((appointment) => {
        if (appointment.patientId === firstRegisteredId) return 'o paciente mais antigo do número';
        if (appointment.patientId === secondRegisteredId) return 'o paciente mais novo do número';
        return 'outro paciente';
      });

      naming = await turn(FROM, 'A consulta é para o Bruno Prado Teste.', {
        intent: bookingRequest(slot),
        decision: 'ASSOCIAR',
        patientNameHint: 'Bruno Prado Teste',
      });
      // A IA entrega o identificador de uma consulta e de uma cobrança reais
      // de um dos dois pacientes do número.
      cancelling = await turn(FROM, 'Cancela a consulta.', {
        intent: { intent: 'cancelar_consulta', entities: { appointmentId: appointmentOfFirst.id } },
        decision: 'IGNORAR',
      });
      billingQuestion = await turn(FROM, 'Quanto estou devendo?', {
        intent: { intent: 'consultar_cobranca', entities: { billingId: billingOfFirst.id } },
        decision: 'IGNORAR',
      });
    }, 60_000);

    it('ninguém é associado ao contato por palpite, nem pelo nome dito na mensagem', async () => {
      const contact = await contactOf(FROM);
      expect(contact?.associations).toHaveLength(0);
      expect(
        await fixturePrisma.contactPatientAssociation.count({
          where: { tenantId: clinicA.fixture.tenantId, patientId: { in: [firstRegisteredId, secondRegisteredId] } },
        }),
      ).toBe(0);
      expect(await patientCount()).toBe(patientsBefore);
    });

    it('[AD-038] com dois pacientes no mesmo número, nenhuma consulta é marcada sem esclarecer para quem é (ADR-0063)', () => {
      expect(bookedFor).toEqual([]);
    });

    it('a conversa não é ligada a nenhum dos dois — nem ao cadastro mais antigo', async () => {
      expect((await conversationOf(FROM))?.patientId).toBeNull();
      expect(await appointmentsAt(slot)).toHaveLength(0);
    });

    it('nenhum paciente é entregue ao provedor de IA, e nada do que é dito traz dado de um deles', () => {
      for (const turnResult of [booking, naming, cancelling, billingQuestion]) {
        expect(turnResult.intentInput.patientId).toBeUndefined();
        expect(turnResult.responseContext.patientId).toBeUndefined();
        expect(turnResult.instructions).toEqual([`[Informe ao paciente: ${CLINIC_WILL_CONTINUE}]`]);
        const everythingSent = JSON.stringify(turnResult.responseContext);
        expect(everythingSent).not.toContain(firstRegisteredId);
        expect(everythingSent).not.toContain(secondRegisteredId);
        expect(everythingSent).not.toContain('Ana Prado');
        expect(everythingSent).not.toMatch(BILLING_AMOUNT);
      }
    });

    it('com o número ambíguo, o classificador de identidade nem é consultado: a regra é uma só', () => {
      for (const turnResult of [booking, naming, cancelling, billingQuestion]) {
        expect(turnResult.classifierCalled).toBe(false);
      }
    });

    it('a consulta de um dos pacientes do número não é cancelada', async () => {
      const appointment = await fixturePrisma.appointment.findUniqueOrThrow({ where: { id: appointmentOfFirst.id } });
      expect(appointment.state).toBe('Reservada');
      expect(actionsIn(cancelling.instructions)).toEqual([]);
    });

    it('a cobrança de um dos pacientes do número não é informada', () => {
      expect(actionsIn(billingQuestion.instructions)).toEqual([]);
    });

    it('a clínica é avisada para assumir a conversa — um aviso só, não um por mensagem', async () => {
      const contact = await contactOf(FROM);
      const notices = await noticesFor(contact!.id, 'whatsapp_shared_number');

      expect(notices).toHaveLength(1);
      expect(notices[0].message).toContain('0005');
      expect(notices[0].message).not.toMatch(/Ana|Bruno/);
    });

    it('um número de mais de um paciente não entra na lista de vínculos a aprovar', async () => {
      const res = await api().get('/api/v1/contacts/pending').set(as(adminA));
      expect(res.body.data.map((contact: { phoneNumber: string }) => contact.phoneNumber)).not.toContain(`+${FROM}`);
    });
  });

  describe('o número passa a ser de dois pacientes depois de a conversa já existir (AD-038)', () => {
    const FROM = '5541988880010';
    const slotBefore = slotAt(7);
    const slotAfter = slotAt(13);
    let firstPatientId: string;
    let before: Turn;
    let after: Turn;

    beforeAll(async () => {
      firstPatientId = await registerPatient('Helena Sá Teste', '+5541988880010', 3);
      before = await turn(FROM, 'Quero marcar uma consulta.', { intent: bookingRequest(slotBefore), decision: 'IGNORAR' });

      // A clínica cadastra, pelo painel, outra pessoa com o mesmo número.
      await registerPatient('Igor Sá Teste', '(41) 98888-0010', 0);
      after = await turn(FROM, 'Quero marcar outra.', { intent: bookingRequest(slotAfter), decision: 'IGNORAR' });
    }, 60_000);

    it('enquanto o número é de um só, o pedido é atendido para ele', async () => {
      expect(before.responseContext.patientId).toBe(firstPatientId);
      expect((await appointmentsAt(slotBefore)).map((appointment) => appointment.patientId)).toEqual([firstPatientId]);
    });

    it('a mensagem seguinte já é tratada como ambígua — a ligação antiga da conversa não identifica ninguém', async () => {
      // A conversa continua guardando o paciente de quando foi aberta; a
      // identidade é calculada a cada mensagem e não se apoia nisso.
      expect((await conversationOf(FROM))?.patientId).toBe(firstPatientId);

      expect(after.intentInput.patientId).toBeUndefined();
      expect(after.responseContext.patientId).toBeUndefined();
      expect(after.classifierCalled).toBe(false);
      expect(await appointmentsAt(slotAfter)).toHaveLength(0);
      expect(after.instructions).toEqual([`[Informe ao paciente: ${CLINIC_WILL_CONTINUE}]`]);
    });
  });

  describe('a IA sinaliza dúvida sobre a identidade (DESAMBIGUAR)', () => {
    const FROM = '5541988880006';
    const slot = slotAt(15);
    const clearSlot = slotAt(17);
    let patientId: string;
    let bookingTurn: Turn;
    let appointmentsBooked: number;

    beforeAll(async () => {
      patientId = await registerPatient('Davi Rocha Teste', '+5541988880006');
      bookingTurn = await turn(FROM, 'Quero marcar a consulta dele.', { intent: bookingRequest(slot), decision: 'DESAMBIGUAR' });
      appointmentsBooked = (await appointmentsAt(slot)).length;
    }, 60_000);

    it('o pedido de confirmação chega à resposta', () => {
      expect(bookingTurn.instructions).toContain(
        '[Pergunte ao paciente: Não ficou claro para qual paciente é esta mensagem — pode confirmar o nome?]',
      );
    });

    it('[AD-038] nada é marcado no turno em que o sistema pede para confirmar a identidade (ADR-0063)', () => {
      expect(appointmentsBooked).toBe(0);
      expect(actionsIn(bookingTurn.instructions)).toEqual([]);
    });

    it('sem dúvida sinalizada na mensagem seguinte, o pedido do paciente reconhecido é atendido', async () => {
      const clear = await turn(FROM, 'É para mim mesmo.', { intent: bookingRequest(clearSlot), decision: 'IGNORAR' });

      expect((await appointmentsAt(clearSlot)).map((appointment) => appointment.patientId)).toEqual([patientId]);
      expect(actionsIn(clear.instructions)).toHaveLength(1);
    });
  });

  describe('ações em nome do paciente só alcançam o que é dele (AD-038)', () => {
    const FROM = '5541988880008';
    const ownSlot = slotAt(18);
    const otherSlot = slotAt(19);
    const movedSlot = slotAt(21);
    let otherAppointmentId: string;
    let ownAppointmentId: string;
    let otherBillingTurn: Turn;
    let ownBillingTurn: Turn;
    let cancelOther: Turn;
    let confirmOther: Turn;
    let rescheduleOther: Turn;
    let sessionsBefore: number;

    beforeAll(async () => {
      const patientId = await registerPatient('Elisa Moura Teste', '+5541988880008');
      const otherPatientId = await registerPatient('Outro Paciente Teste', '+5541977770008');
      ownAppointmentId = (await existingAppointment(patientId, ownSlot)).id;
      otherAppointmentId = (await existingAppointment(otherPatientId, otherSlot)).id;
      const ownBilling = await existingBilling(patientId);
      const otherBilling = await existingBilling(otherPatientId);
      sessionsBefore = await fixturePrisma.session.count({ where: { tenantId: clinicA.fixture.tenantId } });

      // A IA (enganada, ou induzida por quem escreve) entrega o identificador
      // de registros de OUTRO paciente da mesma clínica.
      const about = (intent: string, entities: Record<string, unknown>): Script => ({ intent: { intent, entities }, decision: 'IGNORAR' });
      cancelOther = await turn(FROM, 'Cancela essa consulta.', about('cancelar_consulta', { appointmentId: otherAppointmentId }));
      confirmOther = await turn(FROM, 'Confirma essa consulta.', about('confirmar_presenca', { appointmentId: otherAppointmentId }));
      rescheduleOther = await turn(
        FROM,
        'Remarca essa consulta.',
        about('remarcar_consulta', { appointmentId: otherAppointmentId, newScheduledAt: movedSlot.toISOString() }),
      );
      otherBillingTurn = await turn(FROM, 'Quanto é essa cobrança?', about('consultar_cobranca', { billingId: otherBilling.id }));
      ownBillingTurn = await turn(FROM, 'E a minha cobrança?', about('consultar_cobranca', { billingId: ownBilling.id }));
      await turn(FROM, 'Cancela a minha consulta.', about('cancelar_consulta', { appointmentId: ownAppointmentId }));
    }, 60_000);

    it('a consulta de outro paciente não é cancelada, confirmada nem remarcada', async () => {
      const appointment = await fixturePrisma.appointment.findUniqueOrThrow({ where: { id: otherAppointmentId } });

      expect(appointment.state).toBe('Reservada');
      expect(appointment.scheduledAt).toEqual(otherSlot);
      expect(await fixturePrisma.session.count({ where: { tenantId: clinicA.fixture.tenantId } })).toBe(sessionsBefore);
      for (const turnResult of [cancelOther, confirmOther, rescheduleOther]) {
        expect(actionsIn(turnResult.instructions)).toEqual([]);
      }
    });

    it('a cobrança de outro paciente não é informada; a do próprio paciente é', () => {
      expect(actionsIn(otherBillingTurn.instructions)).toEqual([]);
      expect(JSON.stringify(otherBillingTurn.responseContext)).not.toMatch(BILLING_AMOUNT);
      expect(actionsIn(ownBillingTurn.instructions)).toHaveLength(1);
      expect(ownBillingTurn.instructions[0]).toMatch(BILLING_AMOUNT);
    });

    it('a consulta do próprio paciente é cancelada normalmente', async () => {
      const appointment = await fixturePrisma.appointment.findUniqueOrThrow({ where: { id: ownAppointmentId } });
      expect(appointment.state).toBe('Cancelada');
    });
  });

  describe('isolamento entre clínicas', () => {
    const FROM = '5541988880009';
    let contactA: NonNullable<Awaited<ReturnType<typeof contactOf>>>;
    let contactB: NonNullable<Awaited<ReturnType<typeof contactOf>>>;
    let patientOfA: string;
    let patientOfB: string;

    beforeAll(async () => {
      patientOfA = await registerPatient('Paciente Só da Clínica A Teste', '+5541966660009');
      patientOfB = await registerPatient('Paciente Só da Clínica B Teste', '+5541955550009', 1, clinicB);

      // O mesmo número novo escreve para as duas clínicas.
      const stranger: Script = { intent: SMALL_TALK, decision: 'ASSOCIAR', patientNameHint: 'Alguém Qualquer Teste' };
      await turn(FROM, 'Já sou paciente, troquei de número.', stranger, clinicA);
      await turn(FROM, 'Já sou paciente, troquei de número.', stranger, clinicB);
      contactA = (await contactOf(FROM, clinicA))!;
      contactB = (await contactOf(FROM, clinicB))!;
    }, 60_000);

    it('cada clínica tem o seu contato para o mesmo número, e só vê o seu na lista de pendentes', async () => {
      expect(contactA.id).not.toBe(contactB.id);

      const listA = (await api().get('/api/v1/contacts/pending').set(as(adminA))).body.data.map((contact: { id: string }) => contact.id);
      const listB = (await api().get('/api/v1/contacts/pending').set(as(adminB))).body.data.map((contact: { id: string }) => contact.id);

      expect(listA).toContain(contactA.id);
      expect(listA).not.toContain(contactB.id);
      expect(listB).toEqual([contactB.id]);
    });

    it('o administrador de uma clínica não vincula o contato de outra', async () => {
      const res = await api().post(`/api/v1/contacts/${contactA.id}/link`).set(as(adminB)).send({ patientId: patientOfB });

      expect(res.status).toBe(404);
      expect((await contactOf(FROM, clinicA))?.associations).toHaveLength(0);
      expect((await contactOf(FROM, clinicA))?.state).toBe(contactA.state);
    });

    it('nem vincula o próprio contato a um paciente de outra clínica', async () => {
      const fromB = await api().post(`/api/v1/contacts/${contactB.id}/link`).set(as(adminB)).send({ patientId: patientOfA });
      const fromA = await api().post(`/api/v1/contacts/${contactA.id}/link`).set(as(adminA)).send({ patientId: patientOfB });

      expect(fromB.status).toBe(404);
      expect(fromA.status).toBe(404);
      expect(await fixturePrisma.contactPatientAssociation.count({ where: { contactId: { in: [contactA.id, contactB.id] } } })).toBe(0);
    });

    it('o vínculo aprovado em uma clínica não identifica ninguém na outra', async () => {
      const approved = await api().post(`/api/v1/contacts/${contactB.id}/link`).set(as(adminB)).send({ patientId: patientOfB });
      expect(approved.status).toBe(201);

      const inB = await turn(FROM, 'Olá.', { intent: SMALL_TALK, decision: 'IGNORAR' }, clinicB);
      const inA = await turn(FROM, 'Olá.', { intent: SMALL_TALK, decision: 'IGNORAR' }, clinicA);

      expect(inB.responseContext.patientId).toBe(patientOfB);
      expect(inA.responseContext.patientId).toBeUndefined();
      expect((await contactOf(FROM, clinicA))?.associations).toHaveLength(0);
    });
  });

  it('nenhuma chamada de rede saiu deste arquivo — a IA foi sempre a roteirizada', () => {
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(responseContexts.length).toBeGreaterThan(0);
  });
});
