import { vi } from 'vitest';
import { Appointment, AppointmentState } from '@domain/appointment/appointment.entity';
import { AppointmentNotice } from '@domain/appointment/appointment-notice';
import { AppointmentDecisionRecord, AppointmentOutcomeRecord } from '@domain/appointment/appointment-outcome';
import { Session } from '@domain/session/session.entity';
import { DomainEvent } from '@domain/shared/domain-event';
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
  unitOfWork: { run: <T>(work: () => Promise<T>) => Promise<T> };
  clock: { now: () => Date };
  tenantContext: TenantContext;
}

export function createWorld(options: { userId?: string | null; cancellationHoursLimit?: number | null; available?: boolean } = {}): World {
  const appointments = new Map<string, Appointment>();
  const outcomes = new Map<string, AppointmentOutcomeRecord>();
  const notices: AppointmentNotice[] = [];
  const decisions: AppointmentDecisionRecord[] = [];
  const sessions = new Map<string, Session>();
  const audited: DomainEvent[] = [];
  const now = { value: BEFORE_START };

  const repo: AppointmentRepository = {
    findById: vi.fn(async (id: string) => appointments.get(id) ?? null),
    findByIdForUpdate: vi.fn(async (id: string) => (outcomes.has(id) ? null : (appointments.get(id) ?? null))),
    findSuccessorId: vi.fn(async (id: string) => [...appointments.values()].find((a) => a.rescheduledFromId === id)?.id ?? null),
    findActiveByTherapistAndRange: vi.fn(),
    findByTenantAndRange: vi.fn(),
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
      outcomes.set(record.appointmentId, record);
    }),
    saveDecision: vi.fn(async () => undefined),
    insertDecision: vi.fn(async (decision: AppointmentDecisionRecord) => {
      decisions.push(decision);
    }),
  };
  const noticeRepo: AppointmentNoticeRepository = {
    insert: vi.fn(async (notice: AppointmentNotice) => {
      notices.push(notice);
    }),
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
      recordAll: vi.fn(async (events: DomainEvent[]) => {
        audited.push(...events);
      }),
    },
    unitOfWork: { run: (work) => work() },
    clock: { now: () => now.value },
    tenantContext,
  };
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
