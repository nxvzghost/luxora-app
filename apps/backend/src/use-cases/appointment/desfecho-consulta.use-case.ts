import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Appointment } from '@domain/appointment/appointment.entity';
import { AppointmentDecisionKind, AppointmentOutcomeRecord, AppointmentRuleViolation } from '@domain/appointment/appointment-outcome';
import { Session } from '@domain/session/session.entity';
import { DomainEvent } from '@domain/shared/domain-event';
import { AppointmentRepository, APPOINTMENT_REPOSITORY } from '@domain-services/patient-ops/appointment.repository';
import {
  AppointmentOutcomeRepository,
  APPOINTMENT_OUTCOME_REPOSITORY,
} from '@domain-services/patient-ops/appointment-outcome.repository';
import { SessionRepository, SESSION_REPOSITORY } from '@domain-services/patient-ops/session.repository';
import { UnitOfWork, UNIT_OF_WORK } from '@domain-services/platform/unit-of-work';
import { Clock, CLOCK } from '@domain-services/platform/clock';
import { AuditService } from '@domain-services/platform/audit.service';
import { TenantContext } from '@shared/tenant-context';
import { AppointmentActionResult, loadForTransition, requireHumanActor, withAppointmentRules } from './ciclo-da-consulta';

/**
 * Desfechos de atendimento e decisões sobre a falta — K2-b (ADR-0069,
 * seção 2.5: T6, T7, T8, T9 e T9b; DP-23, DP-24a, DP-26, DP-27).
 *
 * Tudo aqui é de pessoa autenticada: a IA não registra desfecho nem decide
 * cobrança (DP-26). Cada ação roda numa unidade de trabalho, com a linha
 * travada: duas ações sobre a mesma consulta acontecem uma depois da outra,
 * e a segunda vê o que a primeira gravou. Repetir a mesma ação não muda nada
 * nem gera evento; uma ação diferente sobre um desfecho já registrado é
 * recusada (seção 2.8).
 */

export interface AttendanceResult extends AppointmentActionResult {
  /** O item faturável da consulta, se houver. */
  session: Session | null;
}

/**
 * O item faturável do desfecho: a sessão que já existe para a consulta é
 * reaproveitada (a legada, criada pela confirmação, inclusive); senão, nasce
 * uma. Sessão já cobrada não é tocada — o desfecho fica registrado e a
 * cobrança existente segue o ciclo normal (DP-06, DP-27 item 2).
 */
async function billableItemFor(
  sessions: SessionRepository,
  appointment: Appointment,
  kind: 'atendimento' | 'falta',
  now: Date,
): Promise<{ session: Session; events: DomainEvent[]; billedBefore: boolean }> {
  const existing = await sessions.findByAppointmentId(appointment.id);
  if (existing?.isBilled) {
    return { session: existing, events: [], billedBefore: true };
  }
  const session =
    existing ??
    Session.createBillableItem({
      id: randomUUID(),
      tenantId: appointment.tenantId,
      appointmentId: appointment.id,
      patientId: appointment.patientId,
      therapistId: appointment.therapistId,
      kind,
      at: now,
    });
  if (existing && existing.makeBillable(kind, now) === 'unchanged') {
    return { session: existing, events: [], billedBefore: false };
  }
  await sessions.save(session);
  return { session, events: session.pullDomainEvents(), billedBefore: false };
}

/**
 * RegistrarRealizacaoUseCase — T6. O atendimento aconteceu: só pessoa, só
 * depois do início previsto, numa consulta aberta (Reservada, Confirmada ou
 * Reagendada). Cria ou reaproveita o item `atendimento`, elegível para
 * cobrança. Nunca inferido pelo tempo, pela confirmação ou pela cobrança.
 */
@Injectable()
export class RegistrarRealizacaoUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository,
    @Inject(APPOINTMENT_OUTCOME_REPOSITORY) private readonly outcomes: AppointmentOutcomeRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    private readonly auditService: AuditService,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(id: string): Promise<AttendanceResult> {
    const userId = requireHumanActor(this.tenantContext);
    return withAppointmentRules(() =>
      this.unitOfWork.run(async () => {
        const now = this.clock.now();
        const { appointment, outcome: existing } = await loadForTransition(this.repo, this.outcomes, id);
        if (existing) {
          if (existing.outcome !== 'Realizada') throw outcomeConflictWith(existing);
          return { appointment, outcome: existing, changed: false, session: await this.sessions.findByAppointmentId(id) };
        }

        // O desfecho primeiro: a partir daqui a consulta está congelada.
        const outcome = AppointmentOutcomeRecord.recordAttendance(appointment, { userId, now });
        await this.outcomes.insert(outcome);
        const item = await billableItemFor(this.sessions, appointment, 'atendimento', now);
        outcome.markAttendanceRecorded(item.session.id);

        await this.auditService.recordAll([...outcome.pullDomainEvents(), ...item.events]);
        return { appointment, outcome, changed: true, session: item.session };
      }),
    );
  }
}

/**
 * RegistrarFaltaUseCase — T7. O paciente não veio e não avisou: só pessoa,
 * só depois do início previsto. Fica aguardando decisão humana; nenhum item
 * faturável nasce aqui.
 */
@Injectable()
export class RegistrarFaltaUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository,
    @Inject(APPOINTMENT_OUTCOME_REPOSITORY) private readonly outcomes: AppointmentOutcomeRepository,
    private readonly auditService: AuditService,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(id: string): Promise<AppointmentActionResult> {
    const userId = requireHumanActor(this.tenantContext);
    return withAppointmentRules(() =>
      this.unitOfWork.run(async () => {
        const now = this.clock.now();
        const { appointment, outcome: existing } = await loadForTransition(this.repo, this.outcomes, id);
        if (existing) {
          if (existing.outcome !== 'Falta') throw outcomeConflictWith(existing);
          return { appointment, outcome: existing, changed: false };
        }
        const outcome = AppointmentOutcomeRecord.recordNoShow(appointment, { userId, now });
        await this.outcomes.insert(outcome);
        await this.auditService.recordAll(outcome.pullDomainEvents());
        return { appointment, outcome, changed: true };
      }),
    );
  }
}

function outcomeConflictWith(existing: AppointmentOutcomeRecord): AppointmentRuleViolation {
  return new AppointmentRuleViolation(
    'APPOINTMENT_OUTCOME_CONFLICT',
    `Esta consulta já tem desfecho registrado ("${existing.outcome}"); ele não é sobrescrito.`,
  );
}

/**
 * O desfecho travado para uma decisão. A consulta com desfecho está
 * congelada; quem se trava é a linha do desfecho, que só muda nas colunas de
 * decisão.
 */
async function lockOutcomeForDecision(
  repo: AppointmentRepository,
  outcomes: AppointmentOutcomeRepository,
  id: string,
): Promise<{ appointment: Appointment; outcome: AppointmentOutcomeRecord }> {
  const appointment = await repo.findById(id);
  if (!appointment) throw new NotFoundException('Agendamento não encontrado.');
  const outcome = await outcomes.findByAppointmentIdForUpdate(id);
  if (!outcome) {
    throw new AppointmentRuleViolation('APPOINTMENT_OUTCOME_CONFLICT', 'Esta consulta não tem falta registrada.');
  }
  return { appointment, outcome };
}

function decisionRecord(outcome: AppointmentOutcomeRecord, decision: AppointmentDecisionKind, userId: string, now: Date, reason?: string) {
  return {
    id: randomUUID(),
    tenantId: outcome.tenantId,
    appointmentId: outcome.appointmentId,
    decision,
    reason: reason?.trim(),
    decidedAt: now,
    decidedByUserId: userId,
  };
}

/**
 * ConfirmarCobrancaDeFaltaUseCase — T8, só `admin` (rota). A falta passa a
 * ter cobrança confirmada, e o item `falta` nasce (ou a sessão legada da
 * consulta é reaproveitada) elegível. O valor ainda é o digitado na cobrança
 * (o valor aplicável é o MVP-02). Se a consulta já tem uma sessão cobrada
 * (legada), nada é gravado: SESSION_ALREADY_BILLED.
 */
@Injectable()
export class ConfirmarCobrancaDeFaltaUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository,
    @Inject(APPOINTMENT_OUTCOME_REPOSITORY) private readonly outcomes: AppointmentOutcomeRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    private readonly auditService: AuditService,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(id: string): Promise<AttendanceResult> {
    const userId = requireHumanActor(this.tenantContext);
    return withAppointmentRules(() =>
      this.unitOfWork.run(async () => {
        const now = this.clock.now();
        const { appointment, outcome } = await lockOutcomeForDecision(this.repo, this.outcomes, id);
        if (outcome.noShowChargeStatus() === 'confirmed') {
          return { appointment, outcome, changed: false, session: await this.sessions.findByAppointmentId(id) };
        }
        const item = await billableItemFor(this.sessions, appointment, 'falta', now);
        if (item.billedBefore) {
          throw new ConflictException({
            code: 'SESSION_ALREADY_BILLED',
            message: 'Esta consulta já tem uma sessão cobrada; a cobrança da falta não é confirmada por cima dela.',
            category: 'business_rule',
          });
        }
        outcome.confirmNoShowCharge({ userId, now, sessionId: item.session.id });
        await this.outcomes.saveDecision(outcome);
        await this.outcomes.insertDecision(decisionRecord(outcome, 'cobranca_de_falta_confirmada', userId, now));
        await this.auditService.recordAll([...outcome.pullDomainEvents(), ...item.events]);
        return { appointment, outcome, changed: true, session: item.session };
      }),
    );
  }
}

/**
 * AbonarFaltaUseCase — T9. DP-23: quem aprova é o `admin` (o padrão; a
 * habilitação do profissional responsável depende da restrição do terapeuta
 * às próprias consultas, que ainda não existe); o `super_admin` nunca abona,
 * mesmo passando pelo RolesGuard; o motivo é obrigatório e fica em
 * appointment_decision, fora da auditoria. Só a partir da falta aguardando
 * decisão: com a cobrança confirmada, a decisão está encerrada.
 */
@Injectable()
export class AbonarFaltaUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository,
    @Inject(APPOINTMENT_OUTCOME_REPOSITORY) private readonly outcomes: AppointmentOutcomeRepository,
    private readonly auditService: AuditService,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(id: string, input: { reason?: string; actorRole?: string }): Promise<AppointmentActionResult> {
    const userId = requireHumanActor(this.tenantContext);
    if (input.actorRole === 'super_admin') {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'O abono é decisão da clínica: o super_admin não abona falta.', category: 'authorization' });
    }
    return withAppointmentRules(() =>
      this.unitOfWork.run(async () => {
        const now = this.clock.now();
        const { appointment, outcome } = await lockOutcomeForDecision(this.repo, this.outcomes, id);
        if (outcome.excuseNoShow({ userId, now, reason: input.reason }) === 'unchanged') {
          return { appointment, outcome, changed: false };
        }
        await this.outcomes.saveDecision(outcome);
        await this.outcomes.insertDecision(decisionRecord(outcome, 'falta_abonada', userId, now, input.reason));
        await this.auditService.recordAll(outcome.pullDomainEvents());
        return { appointment, outcome, changed: true };
      }),
    );
  }
}

/**
 * ReverterAbonoUseCase — T9b, só `admin` (rota), com motivo (DP-24a). A
 * falta volta a aguardar decisão humana; nenhuma cobrança nasce aqui.
 */
@Injectable()
export class ReverterAbonoUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository,
    @Inject(APPOINTMENT_OUTCOME_REPOSITORY) private readonly outcomes: AppointmentOutcomeRepository,
    private readonly auditService: AuditService,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(id: string, input: { reason?: string }): Promise<AppointmentActionResult> {
    const userId = requireHumanActor(this.tenantContext);
    return withAppointmentRules(() =>
      this.unitOfWork.run(async () => {
        const now = this.clock.now();
        const { appointment, outcome } = await lockOutcomeForDecision(this.repo, this.outcomes, id);
        if (outcome.revertExcuse({ userId, now, reason: input.reason }) === 'unchanged') {
          return { appointment, outcome, changed: false };
        }
        await this.outcomes.saveDecision(outcome);
        await this.outcomes.insertDecision(decisionRecord(outcome, 'abono_revertido', userId, now, input.reason));
        await this.auditService.recordAll(outcome.pullDomainEvents());
        return { appointment, outcome, changed: true };
      }),
    );
  }
}
