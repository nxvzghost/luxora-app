import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ContextIdFactory } from '@nestjs/core';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';
import { knownDefect } from './support/known-defect';
import { TenantContext } from '@shared/tenant-context';
import {
  AI_PROVIDER,
  AIResponse,
  ConversationContext,
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
import {
  WhatsAppInboundJobData,
  WhatsAppInboundQueueProducer,
} from '@infrastructure/messaging/whatsapp-inbound-queue.producer';
import { ProcessarMensagemWhatsAppUseCase } from '@use-cases/communication/processar-mensagem-whatsapp.use-case';

/**
 * Tarefa 06 da auditoria — os cenários de identidade do Contact (11:
 * responsável e dependente; 12: casal no mesmo telefone; 13: troca de
 * número) no FLUXO QUE DE FATO RODA, não em uma classe isolada.
 *
 * Até aqui a cobertura desses cenários era unitária, com repositórios de
 * mentira: provava que o Aggregate e o roteador sabem fazer a coisa certa
 * quando alguém os chama. Este arquivo pergunta outra coisa — o que acontece
 * quando uma mensagem chega pelo webhook.
 *
 * O que é real aqui: a rota do webhook (assinatura, guard, controller), a
 * resolução da clínica pelo número, o Postgres com RLS, os repositórios, os
 * Use Cases de Contact, de conversa e de agenda, a auditoria.
 *
 * O que é de mentira, e só isso:
 *   - o provedor de IA e o classificador de Contact respondem o que o teste
 *     manda. Nenhuma chamada à Anthropic é feita, e este arquivo não prova
 *     nada sobre o que a IA real responderia — prova o que o backend FAZ com
 *     cada resposta possível;
 *   - o produtor da fila de entrada guarda o job em memória. A segunda metade
 *     do caminho é executada aqui do mesmo jeito que o worker a executa (um
 *     contexto por job, a clínica do job, ProcessarMensagemWhatsAppUseCase).
 *     O que é do worker em si — claim, retomada, despacho — já é provado em
 *     whatsapp-inbound-idempotency.test.ts.
 *
 * DOIS TIPOS DE TESTE, e a diferença importa:
 *   - `it(...)`: uma garantia que vale hoje e tem de continuar valendo;
 *   - `knownDefect(...)`: afirma o comportamento decidido na ADR-0063, que o
 *     código ainda não tem — por isso FALHA. Não conta como aprovado em lugar
 *     nenhum: na suíte que libera o CI aparece como pulado e roda de verdade
 *     com `pnpm --filter @luxora/backend test:known-defects` (ver
 *     support/known-defect.ts). O título traz o item de backlog que o
 *     corrige (AD-037 ou AD-038). Cada um confere só um fato já colhido no
 *     beforeAll, para que um erro de preparação não se confunda com o defeito.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let fixture: DedicatedFixture;
let phoneNumberId: string;

const APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? '';
const NO_USAGE: UsageMetrics = { inputTokens: 0, outputTokens: 0, costEstimate: 0, latencyMs: 0 };
const SCRIPTED_REPLY = 'Resposta roteirizada do teste — nenhuma IA real foi chamada.';
const SMALL_TALK = { intent: 'duvida_geral', entities: {} };

/** O que a "IA" responde em um turno: a intenção e a decisão sobre o Contact. */
interface Script {
  intent: Pick<IntentResult, 'intent' | 'entities'>;
  decision: ContactIntentDecision;
  patientNameHint?: string;
}

interface Turn {
  job: WhatsAppInboundJobData;
  /** O que o classificador de Contact recebeu neste turno. */
  classifierInput: ContactIntentClassificationInput;
  /** As instruções que o backend deixou para a resposta ("[Pergunte ao paciente: …]", "[Ação executada: …]"). */
  instructions: string[];
}

let currentScript: Script | undefined;
const capturedJobs: WhatsAppInboundJobData[] = [];
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
  async interpretIntent(): Promise<IntentResult> {
    const script = requireScript();
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
    return { decision: script.decision, confidence: 0.95, patientNameHint: script.patientNameHint, usage: NO_USAGE };
  },
};

const capturingInboundQueue = {
  async enqueue(data: WhatsAppInboundJobData): Promise<void> {
    capturedJobs.push(data);
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

/**
 * Um turno inteiro de conversa: a mensagem entra pelo webhook, de verdade, e
 * o job que ele despachou é processado como o worker processa.
 */
async function turn(from: string, body: string, script: Script): Promise<Turn> {
  const wamid = `wamid.${randomUUID()}`;
  const rawBody = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: phoneNumberId },
              messages: [{ id: wamid, from, type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  });
  const res = await request(app.getHttpServer())
    .post('/api/v1/webhooks/whatsapp')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sign(rawBody))
    .send(rawBody);
  expect(res.status).toBe(200);

  const job = capturedJobs.find((candidate) => candidate.externalId === wamid);
  if (!job) {
    throw new Error(`O webhook não despachou a mensagem ${wamid} para processamento.`);
  }

  currentScript = script;
  try {
    const contextId = ContextIdFactory.create();
    const tenantContext = await app.resolve(TenantContext, contextId, { strict: false });
    tenantContext.set(job.tenantId, null);
    const processar = await app.resolve(ProcessarMensagemWhatsAppUseCase, contextId, { strict: false });
    const result = await processar.execute(job);
    expect(result.responseMessage).toBe(SCRIPTED_REPLY);
  } finally {
    currentScript = undefined;
  }

  const responseContext = responseContexts[responseContexts.length - 1];
  return {
    job,
    classifierInput: classifierInputs[classifierInputs.length - 1],
    instructions: responseContext.conversationHistory
      .filter((message) => message.role === 'assistant' && message.content.startsWith('['))
      .map((message) => message.content),
  };
}

/** Paciente cadastrado pelo painel antes de qualquer conversa. */
async function registerPatient(name: string, phone: string, createdDaysAgo = 1): Promise<string> {
  const patient = await fixturePrisma.patient.create({
    data: {
      tenantId: fixture.tenantId,
      name,
      phone,
      state: 'Cadastrado',
      createdAt: new Date(Date.now() - createdDaysAgo * 24 * 60 * 60 * 1000),
    },
  });
  fixture.patientIds.push(patient.id);
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
    entities: { therapistId: fixture.therapistId, scheduledAt: slot.toISOString(), modality: 'presencial', ...extraEntities },
  };
}

const patientCount = () => fixturePrisma.patient.count({ where: { tenantId: fixture.tenantId } });

const appointmentsAt = (slot: Date) =>
  fixturePrisma.appointment.findMany({ where: { tenantId: fixture.tenantId, scheduledAt: slot } });

const conversationOf = (from: string) =>
  fixturePrisma.conversation.findUnique({
    where: { tenantId_phoneNumber: { tenantId: fixture.tenantId, phoneNumber: from } },
  });

/** O Contact guarda o telefone normalizado ("+55…"); a Meta entrega só os dígitos. */
const contactOf = (from: string) =>
  fixturePrisma.contact.findUnique({
    where: { tenantId_phoneNumber: { tenantId: fixture.tenantId, phoneNumber: `+${from}` } },
    include: { associations: true },
  });

const asksForConfirmation = (instructions: string[]) =>
  instructions.some((instruction) => instruction.startsWith('[Pergunte ao paciente:'));

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchSpy);

  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();

  app = await bootstrapTestApp({
    overrides: [
      { provide: AI_PROVIDER, useValue: scriptedAi },
      { provide: CONTACT_INTENT_CLASSIFIER, useValue: scriptedClassifier },
      { provide: WhatsAppInboundQueueProducer, useValue: capturingInboundQueue },
    ],
  });

  fixture = await createDedicatedFixture(fixturePrisma, 'CONTACTFLOW', { withAvailabilityCalendar: true });
  phoneNumberId = `pnid-${randomUUID()}`;
  await fixturePrisma.whatsAppIntegration.create({
    data: { tenantId: fixture.tenantId, phoneNumberId, accessToken: 'v1:fake:fake:fake', active: true },
  });
}, 60_000);

afterAll(async () => {
  if (fixture) {
    const tenantId = fixture.tenantId;
    const conversations = await fixturePrisma.conversation.findMany({ where: { tenantId }, select: { id: true } });
    const conversationIds = conversations.map((conversation) => conversation.id);
    await fixturePrisma.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await fixturePrisma.conversation.deleteMany({ where: { tenantId } });
    await fixturePrisma.contactPatientAssociation.deleteMany({ where: { tenantId } });
    await fixturePrisma.contact.deleteMany({ where: { tenantId } });
    // Hoje o fluxo não cadastra ninguém. No dia em que cadastrar, o paciente
    // criado por ele não terá id conhecido pelo teste — e a limpeza tem de
    // continuar completa. Mesma justificativa do audit_log na fixture: o
    // filtro é o id de uma clínica que só este arquivo possui.
    const patients = await fixturePrisma.patient.findMany({ where: { tenantId }, select: { id: true } });
    fixture.patientIds = Array.from(new Set([...fixture.patientIds, ...patients.map((patient) => patient.id)]));
  }
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await fixturePrisma?.$disconnect();
  await app?.close();
  vi.unstubAllGlobals();
}, 60_000);

describe('[Contact] identidade no fluxo real do WhatsApp — Cenários 11, 12 e 13 (ADR-0045, ADR-0046, ADR-0055)', () => {
  describe('controle — paciente cadastrado, sozinho no número', () => {
    const FROM = '5541988880001';
    const slot = slotAt(9);
    let patientId: string;
    let patientsBefore: number;
    let patientsAfterBooking: number;
    let patientsAfterPromover: number;
    let booking: Turn;

    beforeAll(async () => {
      patientId = await registerPatient('Paciente Sozinho no Número', '+55 (41) 98888-0001');
      patientsBefore = await patientCount();

      booking = await turn(FROM, 'Quero marcar uma consulta.', { intent: bookingRequest(slot), decision: 'IGNORAR' });
      patientsAfterBooking = await patientCount();

      await turn(FROM, 'É a primeira vez que falo com vocês.', { intent: SMALL_TALK, decision: 'PROMOVER' });
      patientsAfterPromover = await patientCount();
    }, 60_000);

    it('a conversa nasce ligada ao paciente e o pedido de consulta é atendido para ele', async () => {
      expect((await conversationOf(FROM))?.patientId).toBe(patientId);
      expect(booking.job.patientId).toBe(patientId);

      const appointments = await appointmentsAt(slot);
      expect(appointments).toHaveLength(1);
      expect(appointments[0].patientId).toBe(patientId);
      expect(appointments[0].state).toBe('Reservada');
      expect(booking.instructions.some((instruction) => instruction.startsWith('[Ação executada: Consulta agendada'))).toBe(true);
      expect(patientsAfterBooking).toBe(patientsBefore);
    });

    it('a IA tratar a mensagem como primeiro cadastro não cadastra de novo quem já é paciente (D5b)', async () => {
      expect(patientsAfterPromover).toBe(patientsBefore);
      expect((await conversationOf(FROM))?.patientId).toBe(patientId);
    });
  });

  describe('contato novo — Cenários 1 a 3', () => {
    const FROM = '5541988880002';
    const slot = slotAt(10);
    let patientsBefore: number;
    let firstMessage: Turn;
    let patientsAfterFirstMessage: number;
    let appointmentsAfterFirstMessage: number;
    let patientsAfterName: number;
    let appointmentsAfterName: number;
    let patientsAfterConfirmation: number;
    let appointmentsAfterConfirmation: number;

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
      // classificador, as entidades da intenção), para o teste não depender
      // de qual deles um dia será usado.
      const named: Script = {
        intent: bookingRequest(slot, { patientName: 'Marina Duarte Teste' }),
        decision: 'PROMOVER',
        patientNameHint: 'Marina Duarte Teste',
      };
      await turn(FROM, 'Meu nome completo é Marina Duarte Teste.', named);
      patientsAfterName = await patientCount();
      appointmentsAfterName = (await appointmentsAt(slot)).length;

      // E confirma, com todas as letras (ADR-0063: nome completo E confirmação
      // explícita antes de criar o cadastro).
      await turn(FROM, 'Sim, confirmo: sou Marina Duarte Teste e quero me cadastrar para marcar a consulta.', named);
      patientsAfterConfirmation = await patientCount();
      appointmentsAfterConfirmation = (await appointmentsAt(slot)).length;
    }, 60_000);

    it('sem nome, ninguém é cadastrado e nada é marcado — o fluxo pede o nome', async () => {
      expect(firstMessage.job.patientId).toBeUndefined();
      expect(firstMessage.classifierInput.contactState).toBe('Conversando');
      expect(firstMessage.classifierInput.associationCount).toBe(0);
      expect(patientsAfterFirstMessage).toBe(patientsBefore);
      expect(appointmentsAfterFirstMessage).toBe(0);
      expect(firstMessage.instructions).toContain('[Pergunte ao paciente: Antes de agendar, preciso do seu nome completo.]');
    });

    it('o contato novo existe uma única vez, por mais mensagens que mande', async () => {
      expect(await fixturePrisma.contact.count({ where: { tenantId: fixture.tenantId, phoneNumber: `+${FROM}` } })).toBe(1);
      expect(await fixturePrisma.conversation.count({ where: { tenantId: fixture.tenantId, phoneNumber: FROM } })).toBe(1);
    });

    it('só o nome, sem a confirmação explícita, ainda não cadastra ninguém nem marca nada (ADR-0063)', () => {
      expect(patientsAfterName).toBe(patientsBefore);
      expect(appointmentsAfterName).toBe(0);
    });

    // Hoje nenhum código chama Contact.identificar(): o nome nunca é guardado,
    // o contato nunca é promovido e a primeira consulta de quem ainda não é
    // paciente não acontece pelo WhatsApp.
    knownDefect(
      'DEFEITO CONHECIDO (AD-037) — depois de informar o nome completo e confirmar, o contato vira paciente e a primeira consulta é marcada',
      () => {
        expect(patientsAfterConfirmation).toBe(patientsBefore + 1);
        expect(appointmentsAfterConfirmation).toBe(1);
      },
    );
  });

  describe('Cenário 13 — paciente conhecido escreve de um número novo', () => {
    const OLD_NUMBER = '5541988880003';
    const NEW_NUMBER = '5541988880004';
    const slot = slotAt(11);
    let patientId: string;
    let patientsBefore: number;
    let oldContactBefore: Awaited<ReturnType<typeof contactOf>>;
    let claim: Turn;
    let insistence: Turn;

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
      insistence = await turn(NEW_NUMBER, 'Sou eu mesma, a Carla Nunes Teste. Pode marcar.', {
        intent: bookingRequest(slot, { patientName: 'Carla Nunes Teste' }),
        decision: 'PROMOVER',
        patientNameHint: 'Carla Nunes Teste',
      });
    }, 60_000);

    it('o número novo nunca é ligado ao paciente por conta própria', async () => {
      expect(claim.job.patientId).toBeUndefined();
      expect((await conversationOf(NEW_NUMBER))?.patientId).toBeNull();

      const newContact = await contactOf(NEW_NUMBER);
      expect(newContact?.associations).toHaveLength(0);
      expect(newContact?.state).toBe('Conversando');
      expect(
        await fixturePrisma.contactPatientAssociation.count({ where: { tenantId: fixture.tenantId, patientId } }),
      ).toBe(0);
    });

    it('o paciente não é cadastrado de novo e o cadastro dele não muda', async () => {
      expect(await patientCount()).toBe(patientsBefore);
      const patient = await fixturePrisma.patient.findUniqueOrThrow({ where: { id: patientId } });
      expect(patient.phone).toBe('+5541988880003');
      expect(patient.name).toBe('Carla Nunes Teste');
    });

    it('nada é marcado em nome de ninguém antes de confirmar quem está falando', async () => {
      expect(await appointmentsAt(slot)).toHaveLength(0);
    });

    it('o fluxo pede confirmação em vez de agir', () => {
      expect(claim.instructions).toContain(
        '[Pergunte ao paciente: Você mencionou "Carla Nunes Teste" — pode confirmar o nome completo desse paciente?]',
      );
      expect(asksForConfirmation(insistence.instructions)).toBe(true);
      expect(claim.instructions.some((instruction) => instruction.startsWith('[Ação executada:'))).toBe(false);
      expect(insistence.instructions.some((instruction) => instruction.startsWith('[Ação executada:'))).toBe(false);
    });

    it('o Contact do número antigo continua como estava — nunca apagado nem alterado', async () => {
      const oldContactAfter = await contactOf(OLD_NUMBER);
      expect(oldContactAfter?.id).toBe(oldContactBefore?.id);
      expect(oldContactAfter?.state).toBe(oldContactBefore?.state);
      expect(oldContactAfter?.phoneNumber).toBe('+5541988880003');
      expect((await conversationOf(OLD_NUMBER))?.patientId).toBe(patientId);
    });
  });

  describe('Cenários 11 e 12 — mais de um paciente no mesmo número', () => {
    const FROM = '5541988880005';
    const slot = slotAt(14);
    let firstRegisteredId: string;
    let secondRegisteredId: string;
    let patientsBefore: number;
    /** Para quem ficou cada consulta marcada no horário pedido. */
    let bookedFor: string[];

    beforeAll(async () => {
      firstRegisteredId = await registerPatient('Ana Prado Teste', '(41) 98888-0005', 2);
      secondRegisteredId = await registerPatient('Bruno Prado Teste', '(41) 98888-0005', 1);
      patientsBefore = await patientCount();

      // Quem escreve é o segundo. A IA não levanta dúvida nenhuma sobre a
      // identidade (IGNORAR) — o que está em jogo é o que o backend faz
      // sozinho quando o número pertence a duas pessoas.
      await turn(FROM, 'Aqui é o Bruno. Quero marcar uma consulta.', { intent: bookingRequest(slot), decision: 'IGNORAR' });
      bookedFor = (await appointmentsAt(slot)).map((appointment) => {
        if (appointment.patientId === firstRegisteredId) return 'o paciente mais antigo do número';
        if (appointment.patientId === secondRegisteredId) return 'o paciente mais novo do número';
        return 'outro paciente';
      });

      await turn(FROM, 'A consulta é para o Bruno Prado Teste.', {
        intent: SMALL_TALK,
        decision: 'ASSOCIAR',
        patientNameHint: 'Bruno Prado Teste',
      });
    }, 60_000);

    it('ninguém é associado ao contato por palpite, nem pelo nome dito na mensagem', async () => {
      const contact = await contactOf(FROM);
      expect(contact?.associations).toHaveLength(0);
      expect(
        await fixturePrisma.contactPatientAssociation.count({
          where: { tenantId: fixture.tenantId, patientId: { in: [firstRegisteredId, secondRegisteredId] } },
        }),
      ).toBe(0);
      expect(await patientCount()).toBe(patientsBefore);
    });

    // Hoje a conversa é ligada, sem perguntar, ao paciente mais antigo entre
    // os que têm o número, e a consulta é marcada para ele.
    knownDefect(
      'DEFEITO CONHECIDO (AD-038) — com dois pacientes no mesmo número, nenhuma consulta é marcada sem esclarecer para quem é (ADR-0063)',
      () => {
        expect(bookedFor).toEqual([]);
      },
    );
  });

  describe('a IA sinaliza dúvida sobre a identidade (DESAMBIGUAR)', () => {
    const FROM = '5541988880006';
    const slot = slotAt(15);
    let bookingTurn: Turn;
    let appointmentsBooked: number;

    beforeAll(async () => {
      await registerPatient('Davi Rocha Teste', '+5541988880006');
      bookingTurn = await turn(FROM, 'Quero marcar a consulta dele.', { intent: bookingRequest(slot), decision: 'DESAMBIGUAR' });
      appointmentsBooked = (await appointmentsAt(slot)).length;
    }, 60_000);

    it('o pedido de confirmação chega à resposta', () => {
      expect(bookingTurn.instructions).toContain(
        '[Pergunte ao paciente: Não ficou claro para qual paciente é esta mensagem — pode confirmar o nome?]',
      );
    });

    // Hoje o backend pede a confirmação e, no mesmo turno, executa a ação para
    // o paciente da conversa.
    knownDefect(
      'DEFEITO CONHECIDO (AD-038) — nada é marcado no turno em que o sistema pede para confirmar a identidade (ADR-0063)',
      () => {
        expect(appointmentsBooked).toBe(0);
      },
    );
  });

  it('nenhuma chamada de rede saiu deste arquivo — a IA foi sempre a roteirizada', () => {
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(responseContexts.length).toBeGreaterThan(0);
  });
});
