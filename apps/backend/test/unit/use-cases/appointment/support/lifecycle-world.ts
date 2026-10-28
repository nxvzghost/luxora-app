import { vi } from 'vitest';
import { Appointment, AppointmentState } from '@domain/appointment/appointment.entity';
import { AppointmentNotice, NoticeConfirmationAnswer, RequestIntent } from '@domain/appointment/appointment-notice';
import { AppointmentDecisionRecord, AppointmentOutcomeRecord } from '@domain/appointment/appointment-outcome';
import { Session } from '@domain/session/session.entity';
import { DomainEvent } from '@domain/shared/domain-event';
import { Notification } from '@domain/notification/notification.entity';
import { AppointmentRepository } from '@domain-services/patient-ops/appointment.repository';
import { AppointmentOutcomeRepository } from '@domain-services/patient-ops/appointment-outcome.repository';
import { AppointmentNoticeRepository } from '@domain-services/patient-ops/appointment-notice.repository';
import { SessionRepository } from '@domain-services/patient-ops/session.repository';
import { TenantContext } from '@shared/tenant-context';

/**
 * Mundo em memória dos casos de uso do ciclo da consulta (K2-b). Imita o que
 * o banco garante e que os casos de uso pressupõem:
 *   - findByIdForUpdate() não devolve a consulta com desfecho (política
 *     restritiva appointment_frozen_after_outcome);
 *   - save() de uma consulta com desfecho é recusado (chave do retrato);
 *   - um segundo desfecho para a mesma consulta é recusado (chave primária).
 *   - K11: uma mensagem gera no máximo uma comunicação (message_id único), e
 *     o desfecho da IA só entra ligado ao pedido e à resposta `confirma` dele,
 *     antes do início (appointment_outcome_actor_check e chaves compostas).
 * As provas reais disso, no PostgreSQL 16, estão na Suíte Crítica.
 */
export const TENANT_ID = '11111111-1111-1111-1111-111111111111';
export const START = new Date('2026-08-03T09:00:00.000Z');
export const BEFORE_START = new Date(START.getTime() - 48 * 3_600_000);
export const AFTER_START = new Date(START.getTime() + 2 * 3_600_000);

export function appointmentIn(state: AppointmentState, overrides: Partial<{ id: string; patientId: string; scheduledAt: Date }> = {}) {
  return Appointment.reconstitute({
    id: overrides.id ?? 'a1',
    tenantId: TENANT_ID,
    patientId: overrides.patientId ?? 'p1',
    therapistId: 't1',
    scheduledAt: overrides.scheduledAt ?? START,
    modality: 'presencial',
    state,
    recurring: false,
  });
}

export const CONVERSATION_ID = 'conversa-1';
export const NEW_SLOT = new Date('2026-08-10T09:00:00.000Z');

/**
 * K11 — o pedido feito pelo WhatsApp, já registrado (como o caso de uso do
 * pedido grava): uma hora antes de BEFORE_START, por padrão.
 */
export function whatsAppRequest(
  world: World,
  appointment: Appointment,
  options: { action?: 'cancelar' | 'remarcar'; intent?: RequestIntent; proposedScheduledAt?: Date; receivedAt?: Date; conversationId?: string } = {},
): AppointmentNotice {
  const action = options.action ?? 'cancelar';
  const receivedAt = options.receivedAt ?? new Date(BEFORE_START.getTime() - 3_600_000);
  const sequence = world.notices.length + 1;
  const request = AppointmentNotice.requestFromWhatsApp({
    id: `pedido-${sequence}`,
    appointment,
    intent: options.intent ?? (action === 'remarcar' ? 'pedido_remarcacao' : 'pedido_cancelamento'),
    proposedScheduledAt: action === 'remarcar' ? (options.proposedScheduledAt ?? NEW_SLOT) : undefined,
    message: { conversationId: options.conversationId ?? CONVERSATION_ID, messageId: `wamid.${sequence}`, receivedAt },
    now: receivedAt,
  });
  request.pullDomainEvents();
  world.notices.push(request);
  return request;
}

/** K11 — a resposta do paciente ao pedido, em outra mensagem (cinco minutos depois, por padrão). */
export function whatsAppReply(
  world: World,
  request: AppointmentNotice,
  appointment: Appointment,
  answer: NoticeConfirmationAnswer,
  receivedAt: Date = new Date((request.receivedAt as Date).getTime() + 5 * 60_000),
): AppointmentNotice {
  const sequence = world.notices.length + 1;
  const reply = AppointmentNotice.replyFromWhatsApp({
    id: `resposta-${sequence}`,
    request,
    appointment,
    answer,
    message: { conversationId: request.conversationId as string, messageId: `wamid.${sequence}`, receivedAt },
    now: receivedAt,
  });
  reply.pullDomainEvents();
  world.notices.push(reply);
  return reply;
}

export function legacySession(overrides: Partial<{ state: 'Realizada' | 'Faturada' | 'Recebida'; appointmentId: string }> = {}) {
  return Session.reconstitute({
    id: 's-legada',
    tenantId: TENANT_ID,
    appointmentId: overrides.appointmentId ?? 'a1',
    patientId: 'p1',
    therapistId: 't1',
    state: overrides.state ?? 'Realizada',
    billingEligibility: 'nao_elegivel',
  });
}

export interface World {
  appointments: Map<string, Appointment>;
  outcomes: Map<string, AppointmentOutcomeRecord>;
  notices: AppointmentNotice[];
  decisions: AppointmentDecisionRecord[];
  sessions: Map<string, Session>;
  audited: DomainEvent[];
  now: { value: Date };
  repo: AppointmentRepository;
  outcomeRepo: AppointmentOutcomeRepository;
  noticeRepo: AppointmentNoticeRepository;
  sessionRepo: SessionRepository;
  clinicRepo: { findByTenantId: ReturnType<typeof vi.fn> };
  motor: { execute: ReturnType<typeof vi.fn> };
  audit: { recordAll: ReturnType<typeof vi.fn> };
  /** O ator de cada evento auditado (o segundo argumento de recordAll). */
  auditedActors: Array<{ event: string; actor: string | undefined }>;
  unitOfWork: { run: <T>(work: () => Promise<T>) => Promise<T> };
  clock: { now: () => Date };
  tenantContext: TenantContext;
  /** K11 — notificações do painel, nomes dos profissionais e fuso da clínica. */
  notifications: Notification[];
  notificationRepo: { hasUnread: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  therapistRepo: { findAllByTenant: ReturnType<typeof vi.fn> };
  clinicTimeZone: { current: ReturnType<typeof vi.fn> };
}

export function createWorld(options: { userId?: string | null; cancellationHoursLimit?: number | null; available?: boolean } = {}): World {
  const appointments = new Map<string, Appointment>();
  const outcomes = new Map<string, AppointmentOutcomeRecord>();
  const notices: AppointmentNotice[] = [];
  const decisions: AppointmentDecisionRecord[] = [];
  const sessions = new Map<string, Session>();
  const audited: DomainEvent[] = [];
  const auditedActors: Array<{ event: string; actor: string | undefined }> = [];
  const notifications: Notification[] = [];
  const now = { value: BEFORE_START };

  const repo: AppointmentRepository = {
    findById: vi.fn(async (id: string) => appointments.get(id) ?? null),
    findByIdForUpdate: vi.fn(async (id: string) => (outcomes.has(id) ? null : (appointments.get(id) ?? null))),
    findSuccessorId: vi.fn(async (id: string) => [...appointments.values()].find((a) => a.rescheduledFromId === id)?.id ?? null),
    findActiveByTherapistAndRange: vi.fn(),
    findByTenantAndRange: vi.fn(),
    findOpenByPatientAndRange: vi.fn(async (patientId: string, from: Date, to: Date) =>
      [...appointments.values()]
        .filter((a) => a.patientId === patientId && a.isOpen && a.scheduledAt >= from && a.scheduledAt <= to)
        .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime()),
    ),
    save: vi.fn(async (appointment: Appointment) => {
      if (outcomes.has(appointment.id)) throw new Error('banco: consulta com desfecho (appointment_outcome_freeze_fkey)');
      appointments.set(appointment.id, appointment);
    }),
    saveMany: vi.fn(),
    existsForRecurringBlockOccurrence: vi.fn(),
  };
  const outcomeRepo: AppointmentOutcomeRepository = {
    findByAppointmentId: vi.fn(async (id: string) => outcomes.get(id) ?? null),
    findByAppointmentIdForUpdate: vi.fn(async (id: string) => outcomes.get(id) ?? null),
    findByAppointmentIds: vi.fn(async (ids: string[]) => new Map(ids.filter((id) => outcomes.has(id)).map((id) => [id, outcomes.get(id) as AppointmentOutcomeRecord]))),
    insert: vi.fn(async (record: AppointmentOutcomeRecord) => {
      if (outcomes.has(record.appointmentId)) throw new Error('banco: appointment_outcome_pkey');
      const appointment = appointments.get(record.appointmentId);
      if (!appointment || appointment.state !== record.stateAtOutcome || appointment.scheduledAt.getTime() !== record.scheduledAtAtOutcome.getTime()) {
        throw new Error('banco: o retrato não confere com a consulta (appointment_outcome_freeze_fkey)');
      }
      if (record.recordedByActorType === 'ai_agent') assertAiOutcomeAsTheDatabaseDoes(record, notices);
      if (record.recordedByActorType === 'user' && !record.recordedByUserId) throw new Error('banco: appointment_outcome_actor_check');
      outcomes.set(record.appointmentId, record);
    }),
    saveDecision: vi.fn(async () => undefined),
    insertDecision: vi.fn(async (decision: AppointmentDecisionRecord) => {
      decisions.push(decision);
    }),
  };
  const byArrival = (a: AppointmentNotice, b: AppointmentNotice) =>
    (a.receivedAt ?? a.recordedAt).getTime() - (b.receivedAt ?? b.recordedAt).getTime() || a.recordedAt.getTime() - b.recordedAt.getTime();
  const noticeRepo: AppointmentNoticeRepository = {
    insert: vi.fn(async (notice: AppointmentNotice) => {
      if (notice.messageId && notices.some((n) => n.messageId === notice.messageId)) throw new Error('banco: appointment_notice_message_id_key');
      notices.push(notice);
    }),
    findByMessageId: vi.fn(async (messageId: string) => notices.find((n) => n.messageId === messageId) ?? null),
    findRequests: vi.fn(async (query: { since: Date; conversationId?: string }) =>
      notices
        .filter((n) => n.awaitsConfirmation && n.recordedAt >= query.since && (!query.conversationId || n.conversationId === query.conversationId))
        .sort(byArrival)
        .map((request) => ({ request, replies: notices.filter((n) => n.confirmsNoticeId === request.id).sort(byArrival) })),
    ),
  };
  const sessionRepo: SessionRepository = {
    findById: vi.fn(async (id: string) => sessions.get(id) ?? null),
    findByAppointmentId: vi.fn(async (id: string) => [...sessions.values()].find((s) => s.appointmentId === id) ?? null),
    save: vi.fn(async (session: Session) => {
      sessions.set(session.id, session);
    }),
    findSummaries: vi.fn(),
  };
  const tenantContext = new TenantContext();
  tenantContext.set(TENANT_ID, options.userId === undefined ? 'user-1' : options.userId);

  return {
    appointments,
    outcomes,
    notices,
    decisions,
    sessions,
    audited,
    now,
    repo,
    outcomeRepo,
    noticeRepo,
    sessionRepo,
    clinicRepo: { findByTenantId: vi.fn(async () => ({ cancellationHoursLimit: options.cancellationHoursLimit ?? undefined })) },
    motor: { execute: vi.fn().mockResolvedValue(options.available ?? true) },
    audit: {
      recordAll: vi.fn(async (events: DomainEvent[], actor?: string) => {
        audited.push(...events);
        auditedActors.push(...events.map((event) => ({ event: event.eventName, actor })));
      }),
    },
    auditedActors,
    unitOfWork: { run: (work) => work() },
    clock: { now: () => now.value },
    tenantContext,
    notifications,
    notificationRepo: {
      hasUnread: vi.fn(async (type: string, entityId: string) => notifications.some((n) => n.type === type && n.entityId === entityId && !n.isRead)),
      create: vi.fn(async (notification: Notification) => {
        notifications.push(notification);
      }),
    },
    therapistRepo: { findAllByTenant: vi.fn(async () => [{ id: 't1', name: 'Dra. Paula Souza' }]) },
    clinicTimeZone: { current: vi.fn(async () => 'America/Sao_Paulo') },
  };
}

/**
 * O que o banco confere no desfecho da IA (appointment_outcome_actor_check,
 * appointment_outcome_request_fkey, appointment_outcome_confirmation_fkey):
 * sem usuário, só cancelamento ou remarcação, ligado a um pedido da mesma
 * consulta com a ação correspondente e a uma resposta `confirma` desse pedido
 * recebida antes do início.
 */
function assertAiOutcomeAsTheDatabaseDoes(record: AppointmentOutcomeRecord, notices: AppointmentNotice[]): void {
  const request = notices.find((n) => n.id === record.closingNoticeId);
  const confirmation = notices.find((n) => n.id === record.confirmationNoticeId);
  const action = record.outcome === 'Cancelada' ? 'cancelar' : record.outcome === 'Remarcada' ? 'remarcar' : null;
  if (
    record.recordedByUserId ||
    !action ||
    !request ||
    request.appointmentId !== record.appointmentId ||
    request.requestedAction !== action ||
    !confirmation ||
    confirmation.appointmentId !== record.appointmentId ||
    confirmation.confirmsNoticeId !== request.id ||
    confirmation.confirmationAnswer !== 'confirma' ||
    confirmation.timing === 'depois_do_inicio'
  ) {
    throw new Error('banco: appointment_outcome_actor_check / appointment_outcome_confirmation_fkey');
  }
}

export function withAppointment(world: World, appointment: Appointment): Appointment {
  world.appointments.set(appointment.id, appointment);
  return appointment;
}

/** O código de erro que a API devolveria ({ code } do corpo da exceção HTTP). */
export async function errorOf(work: Promise<unknown>): Promise<{ status?: number; code?: string }> {
  try {
    await work;
  } catch (err) {
    const http = err as { getStatus?: () => number; getResponse?: () => unknown };
    const body = http.getResponse?.() as { code?: string } | undefined;
    return { status: http.getStatus?.(), code: typeof body === 'object' ? body?.code : undefined };
  }
  return { code: 'sem erro' };
}
