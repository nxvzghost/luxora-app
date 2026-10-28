import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { Appointment } from '@domain/appointment/appointment.entity';
import { AppointmentNotice } from '@domain/appointment/appointment-notice';
import { AppointmentOutcomeRecord } from '@domain/appointment/appointment-outcome';
import { PrismaAppointmentNoticeRepository } from '@infrastructure/database/repositories/prisma-appointment-notice.repository';
import { PrismaAppointmentOutcomeRepository } from '@infrastructure/database/repositories/prisma-appointment-outcome.repository';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { TenantContext } from '@shared/tenant-context';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from '../../critical/support/dedicated-fixture';

/**
 * K11 — os repositórios do pedido pelo WhatsApp contra Postgres real, sob RLS
 * e com o papel da aplicação: a ida e volta das colunas novas (pedido,
 * resposta, desfecho da IA), a busca por mensagem e a leitura dos pedidos
 * com as respostas, por conversa e sem nada de outra clínica.
 *
 * Instantes fixos (2031, longe de qualquer "hoje").
 */
function ensureDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return;
  const content = readFileSync(path.resolve(__dirname, '../../../.env'), 'utf-8');
  const match = content.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/m);
  if (!match) throw new Error('DATABASE_URL não encontrado em apps/backend/.env');
  process.env.DATABASE_URL = match[1];
}

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

ensureDatabaseUrl();

const START = new Date('2031-05-20T13:00:00.000Z');
const ASKED_AT = new Date('2031-05-18T10:00:00.000Z');
const ANSWERED_AT = new Date('2031-05-18T10:05:00.000Z');
const NEW_SLOT = new Date('2031-05-22T13:00:00.000Z');

let fixturePrisma: PrismaClient;
let clientProvider: PrismaClientProvider;
let clinicA: DedicatedFixture;
let clinicB: DedicatedFixture;

function prismaFor(tenantId: string): PrismaService {
  const tenantContext = new TenantContext();
  tenantContext.set(tenantId, null);
  return new PrismaService(clientProvider, tenantContext);
}

async function seedAppointment(fixture: DedicatedFixture, scheduledAt: Date): Promise<Appointment> {
  const row = await fixturePrisma.appointment.create({
    data: { tenantId: fixture.tenantId, patientId: fixture.patientId, therapistId: fixture.therapistId, scheduledAt, state: 'Reservada' },
  });
  fixture.appointmentIds.push(row.id);
  return Appointment.reconstitute({
    id: row.id,
    tenantId: row.tenantId,
    patientId: row.patientId,
    therapistId: row.therapistId,
    scheduledAt: row.scheduledAt,
    modality: row.modality as 'presencial' | 'online',
    state: 'Reservada',
    recurring: false,
  });
}

async function seedConversation(fixture: DedicatedFixture): Promise<string> {
  const conversation = await fixturePrisma.conversation.create({
    data: { tenantId: fixture.tenantId, phoneNumber: `+55279${randomUUID().replace(/\D/g, '').slice(0, 8)}`, patientId: fixture.patientId },
  });
  return conversation.id;
}

const message = (conversationId: string, receivedAt: Date) => ({ conversationId, messageId: `wamid.${randomUUID()}`, receivedAt });

async function cleanup(fixture: DedicatedFixture | undefined): Promise<void> {
  if (!fixture) return;
  await fixturePrisma.appointmentOutcomeRecord.deleteMany({ where: { tenantId: fixture.tenantId } });
  await fixturePrisma.appointmentNotice.deleteMany({ where: { tenantId: fixture.tenantId } });
  await fixturePrisma.conversation.deleteMany({ where: { tenantId: fixture.tenantId } });
  await cleanupDedicatedFixture(fixturePrisma, fixture);
}

let appointment: Appointment;
let conversation1: string;
let conversation2: string;
let request1: AppointmentNotice;
let reply1: AppointmentNotice;
let request2: AppointmentNotice;
let requestB: AppointmentNotice;

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  clientProvider = new PrismaClientProvider();
  clinicA = await createDedicatedFixture(fixturePrisma, 'K11REPOA');
  clinicB = await createDedicatedFixture(fixturePrisma, 'K11REPOB');

  appointment = await seedAppointment(clinicA, START);
  conversation1 = await seedConversation(clinicA);
  conversation2 = await seedConversation(clinicA);
  const notices = new PrismaAppointmentNoticeRepository(prismaFor(clinicA.tenantId));

  request1 = AppointmentNotice.requestFromWhatsApp({ id: randomUUID(), appointment, intent: 'pedido_cancelamento', message: message(conversation1, ASKED_AT), now: ASKED_AT });
  await notices.insert(request1);
  reply1 = AppointmentNotice.replyFromWhatsApp({
    id: randomUUID(),
    request: request1,
    appointment,
    answer: 'confirma',
    message: message(conversation1, ANSWERED_AT),
    now: ANSWERED_AT,
  });
  await notices.insert(reply1);
  request2 = AppointmentNotice.requestFromWhatsApp({
    id: randomUUID(),
    appointment,
    intent: 'pedido_remarcacao',
    proposedScheduledAt: NEW_SLOT,
    message: message(conversation2, new Date(ASKED_AT.getTime() + 60 * 60_000)),
    now: new Date(ASKED_AT.getTime() + 60 * 60_000),
  });
  await notices.insert(request2);

  const appointmentB = await seedAppointment(clinicB, START);
  requestB = AppointmentNotice.requestFromWhatsApp({
    id: randomUUID(),
    appointment: appointmentB,
    intent: 'pedido_cancelamento',
    message: message(await seedConversation(clinicB), ASKED_AT),
    now: ASKED_AT,
  });
  await new PrismaAppointmentNoticeRepository(prismaFor(clinicB.tenantId)).insert(requestB);
}, 60_000);

afterAll(async () => {
  await cleanup(clinicA);
  await cleanup(clinicB);
  await clientProvider?.$disconnect();
  await fixturePrisma?.$disconnect();
});

describe('PrismaAppointmentNoticeRepository — K11', () => {
  it('findByMessageId devolve o pedido com todas as colunas do K11 (ida e volta)', async () => {
    const found = await new PrismaAppointmentNoticeRepository(prismaFor(clinicA.tenantId)).findByMessageId(request2.messageId as string);
    expect(found).not.toBeNull();
    expect([found?.awaitsConfirmation, found?.requestedAction, found?.intent, found?.askedScheduledAt, found?.askedModality, found?.proposedScheduledAt]).toEqual([
      true,
      'remarcar',
      'pedido_remarcacao',
      START,
      'presencial',
      NEW_SLOT,
    ]);
    expect([found?.conversationId, found?.receivedAt, found?.referenceSource, found?.recordedByActorType, found?.recordedByUserId]).toEqual([
      conversation2,
      request2.receivedAt,
      'recebimento_webhook',
      'ai_agent',
      undefined,
    ]);
    expect(found?.stillDescribes(appointment)).toBe(true);
  });

  it('a resposta volta ligada ao pedido, com a classificação', async () => {
    const found = await new PrismaAppointmentNoticeRepository(prismaFor(clinicA.tenantId)).findByMessageId(reply1.messageId as string);
    expect([found?.awaitsConfirmation, found?.confirmsNoticeId, found?.confirmationAnswer, found?.requestedAction, found?.reviewStatus]).toEqual([
      false,
      request1.id,
      'confirma',
      undefined,
      'sem_revisao_necessaria',
    ]);
  });

  it('findRequests por conversa: só os pedidos dela, cada um com as respostas, da mais antiga para a mais nova', async () => {
    const threads = await new PrismaAppointmentNoticeRepository(prismaFor(clinicA.tenantId)).findRequests({ since: new Date('2031-01-01T00:00:00Z'), conversationId: conversation1 });
    expect(threads.map(({ request, replies }) => [request.id, replies.map((r) => r.id)])).toEqual([[request1.id, [reply1.id]]]);
  });

  it('findRequests sem conversa: os pedidos da clínica em ordem de chegada, sem nada de outra clínica; respostas não aparecem como pedidos', async () => {
    const threads = await new PrismaAppointmentNoticeRepository(prismaFor(clinicA.tenantId)).findRequests({ since: new Date('2031-01-01T00:00:00Z') });
    expect(threads.map(({ request }) => request.id)).toEqual([request1.id, request2.id]);
    expect(threads.map(({ request }) => request.id)).not.toContain(requestB.id);
  });

  it('findRequests respeita o início do período', async () => {
    const threads = await new PrismaAppointmentNoticeRepository(prismaFor(clinicA.tenantId)).findRequests({ since: new Date(ASKED_AT.getTime() + 30 * 60_000) });
    expect(threads.map(({ request }) => request.id)).toEqual([request2.id]);
  });

  it('a mesma mensagem não é gravada duas vezes', async () => {
    const again = AppointmentNotice.replyFromWhatsApp({
      id: randomUUID(),
      request: request1,
      appointment,
      answer: 'recusa',
      message: { conversationId: conversation1, messageId: reply1.messageId as string, receivedAt: ANSWERED_AT },
      now: ANSWERED_AT,
    });
    await expect(new PrismaAppointmentNoticeRepository(prismaFor(clinicA.tenantId)).insert(again)).rejects.toThrow();
  });
});

describe('PrismaAppointmentOutcomeRepository — desfecho de autoria da IA (K11, D1)', () => {
  it('grava e lê o desfecho da IA: sem usuário, ligado ao pedido e à confirmação', async () => {
    await fixturePrisma.appointment.update({ where: { id: appointment.id }, data: { state: 'Cancelada' } });
    appointment.transitionTo('Cancelada');
    const record = AppointmentOutcomeRecord.closeByConfirmedRequest(appointment, request1, reply1, 'Cancelada', { now: ANSWERED_AT });
    const outcomes = new PrismaAppointmentOutcomeRepository(prismaFor(clinicA.tenantId));
    await outcomes.insert(record);

    const found = await outcomes.findByAppointmentId(appointment.id);
    expect([found?.outcome, found?.recordedByActorType, found?.recordedByUserId]).toEqual(['Cancelada', 'ai_agent', undefined]);
    expect([found?.closingNoticeId, found?.closingRequestedAction, found?.confirmationNoticeId, found?.confirmationAnswer, found?.confirmationNoticeTiming]).toEqual([
      request1.id,
      'cancelar',
      reply1.id,
      'confirma',
      reply1.timing,
    ]);
    const row = await fixturePrisma.appointmentOutcomeRecord.findUniqueOrThrow({ where: { appointmentId: appointment.id } });
    expect([row.outcomeRecordedByActorType, row.outcomeRecordedByUserId]).toEqual(['ai_agent', null]);
  });
});
