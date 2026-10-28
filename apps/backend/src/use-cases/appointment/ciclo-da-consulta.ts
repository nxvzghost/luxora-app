import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Appointment } from '@domain/appointment/appointment.entity';
import type { AppointmentNotice } from '@domain/appointment/appointment-notice';
import { AppointmentOutcomeRecord, AppointmentRuleViolation } from '@domain/appointment/appointment-outcome';
import { InvalidStateTransitionError } from '@domain/shared/state-machine';
import { AppointmentRepository } from '@domain-services/patient-ops/appointment.repository';
import { AppointmentOutcomeRepository } from '@domain-services/patient-ops/appointment-outcome.repository';
import { TenantContext } from '@shared/tenant-context';

/**
 * Peças comuns dos casos de uso do ciclo da consulta — K2-b (ADR-0069,
 * seções 2.5 a 2.8).
 */

/**
 * ADR-0063 (AD-038) — quem age em nome de um paciente (o agente do WhatsApp)
 * informa de quem a consulta tem de ser. As rotas do painel não informam:
 * lá quem age é a equipe da clínica, já autorizada pelo papel.
 *
 * K2-b — `actor: 'ai_agent'` marca a ação da IA, auditada com esse ator.
 *
 * K11 (D1, D4) — a IA só cancela ou remarca com `aiConfirmation`: o pedido
 * feito pelo WhatsApp e a resposta `confirma` do paciente a ele, já
 * registrados. O caso de uso confere de novo, com a consulta travada, que
 * ela ainda é a perguntada e que nada começou, e grava o desfecho de autoria
 * `ai_agent` ligado aos dois. Sem eles, a IA não cancela nem remarca nada.
 * Confirmar presença continua sem essa exigência (não tem efeito financeiro
 * e não é desfecho).
 */
export interface AppointmentActionOptions {
  expectedPatientId?: string;
  actor?: 'ai_agent';
  aiConfirmation?: { request: AppointmentNotice; confirmation: AppointmentNotice };
}

/**
 * K11 — a confirmação vale para a consulta como ela está agora: aberta, sem
 * desfecho, igual à perguntada (horário e modalidade), e a resposta é a
 * `confirma` desse pedido, recebida antes do início. A consulta mudada no
 * intervalo responde APPOINTMENT_REQUEST_STALE, e nada é executado.
 */
export function assertAiConfirmationStillValid(appointment: Appointment, options: AppointmentActionOptions, now: Date): {
  request: AppointmentNotice;
  confirmation: AppointmentNotice;
} {
  const ai = options.aiConfirmation;
  if (!ai) {
    throw new ForbiddenException({
      code: 'PATIENT_CONFIRMATION_REQUIRED',
      message: 'A IA só cancela ou remarca uma consulta depois da confirmação explícita do paciente (K11).',
      category: 'authorization',
    });
  }
  if (ai.confirmation.confirmsNoticeId !== ai.request.id || ai.confirmation.confirmationAnswer !== 'confirma') {
    throw new ForbiddenException({
      code: 'PATIENT_CONFIRMATION_REQUIRED',
      message: 'A resposta registrada não confirma este pedido.',
      category: 'authorization',
    });
  }
  if (!ai.request.stillDescribes(appointment) || !appointment.isOpen) {
    throw new AppointmentRuleViolation('APPOINTMENT_REQUEST_STALE', 'A consulta mudou depois da pergunta: a confirmação não vale para ela.');
  }
  if (appointment.hasStarted(now) || !ai.confirmation.isBeforeStart) {
    throw new AppointmentRuleViolation('APPOINTMENT_ALREADY_STARTED', 'A consulta já começou: não pode mais ser cancelada nem remarcada.');
  }
  return ai;
}

/** A consulta com a linha travada, ou, se ela tem desfecho, o desfecho que a congela. */
export interface LoadedAppointment {
  appointment: Appointment;
  outcome: AppointmentOutcomeRecord | null;
}

function notFound(): NotFoundException {
  return new NotFoundException('Agendamento não encontrado.');
}

/**
 * Lê a consulta para uma transição, dentro da unidade de trabalho, com a
 * linha travada (uma transição por vez). A consulta com desfecho não é
 * travada nem atualizada — o banco a deixa fora do alcance do papel da
 * aplicação —; volta lida sem trava, com o desfecho, para quem chama
 * responder pela regra (repetição sem efeito ou conflito).
 *
 * Depois da trava, o desfecho é lido de novo: se outro registro esperou a
 * mesma trava e gravou um desfecho primeiro, ele aparece aqui.
 */
export async function loadForTransition(
  repo: AppointmentRepository,
  outcomes: AppointmentOutcomeRepository,
  id: string,
  options?: AppointmentActionOptions,
): Promise<LoadedAppointment> {
  const locked = await repo.findByIdForUpdate(id);
  const appointment = locked ?? (await repo.findById(id));
  // A consulta de outro paciente responde como inexistente: a mesma
  // resposta, para não confirmar a ninguém que aquele id existe.
  if (!appointment || (options?.expectedPatientId && appointment.patientId !== options.expectedPatientId)) {
    throw notFound();
  }
  const outcome = await outcomes.findByAppointmentId(id);
  if (!locked && !outcome) {
    // Sem trava e sem desfecho: só se a consulta sumir da RLS entre as duas leituras.
    throw notFound();
  }
  return { appointment, outcome };
}

/** O usuário da requisição; ações de pessoa (desfecho, decisão, comunicação pelo painel) exigem um. */
export function requireHumanActor(tenantContext: TenantContext): string {
  const userId = tenantContext.isInitialized ? tenantContext.userId : null;
  if (!userId) {
    throw new ForbiddenException({
      code: 'HUMAN_ACTOR_REQUIRED',
      message: 'Só uma pessoa autenticada registra o desfecho de uma consulta.',
      category: 'authorization',
    });
  }
  return userId;
}

/** Erros de regra do ciclo da consulta na forma da API ({ code, message, category }). */
export function asHttpError(err: unknown): unknown {
  if (err instanceof AppointmentRuleViolation) {
    const body = { code: err.code, message: err.message, category: 'business_rule' as const };
    return err.code === 'REASON_REQUIRED' ? new BadRequestException({ ...body, category: 'validation' }) : new ConflictException(body);
  }
  if (err instanceof InvalidStateTransitionError) {
    return new ConflictException({ code: 'INVALID_STATE_TRANSITION', message: err.message, category: 'business_rule' });
  }
  return err;
}

/** Executa `work` traduzindo os erros de regra (ver asHttpError). */
export async function withAppointmentRules<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw asHttpError(err);
  }
}

/** Resultado de uma ação: `changed` falso quando era uma repetição sem efeito (a API responde 200, sem evento novo). */
export interface AppointmentActionResult {
  appointment: Appointment;
  outcome: AppointmentOutcomeRecord | null;
  changed: boolean;
}
