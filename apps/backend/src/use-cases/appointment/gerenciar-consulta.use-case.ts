import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Appointment } from '@domain/appointment/appointment.entity';
import { AppointmentNotice, NoticeRequestedBy } from '@domain/appointment/appointment-notice';
import { AppointmentOutcomeRecord, AppointmentRuleViolation } from '@domain/appointment/appointment-outcome';
import { DomainEvent } from '@domain/shared/domain-event';
import {
  AppointmentRepository,
  APPOINTMENT_REPOSITORY,
} from '@domain-services/patient-ops/appointment.repository';
import {
  AppointmentOutcomeRepository,
  APPOINTMENT_OUTCOME_REPOSITORY,
} from '@domain-services/patient-ops/appointment-outcome.repository';
import {
  AppointmentNoticeRepository,
  APPOINTMENT_NOTICE_REPOSITORY,
} from '@domain-services/patient-ops/appointment-notice.repository';
import { ClinicRepository, CLINIC_REPOSITORY } from '@domain-services/platform/clinic.repository';
import { UnitOfWork, UNIT_OF_WORK } from '@domain-services/platform/unit-of-work';
import { Clock, CLOCK } from '@domain-services/platform/clock';
import { AuditService } from '@domain-services/platform/audit.service';
import { TenantContext } from '@shared/tenant-context';
import { VerificarDisponibilidadeUseCase } from '@use-cases/availability/verificar-disponibilidade.use-case';
import { SlotNotAvailableError } from '@domain-services/availability/slot-not-available.error';
import {
  AppointmentActionOptions,
  AppointmentActionResult,
  loadForTransition,
  requireHumanActor,
  withAppointmentRules,
} from './ciclo-da-consulta';

export type { AppointmentActionOptions } from './ciclo-da-consulta';

/** Quem pediu e o motivo — o que o painel informa ao cancelar ou remarcar (DP-25). */
export interface NoticeInput {
  requestedBy?: NoticeRequestedBy;
  reason?: string;
}

function alreadyStarted(): AppointmentRuleViolation {
  return new AppointmentRuleViolation('APPOINTMENT_ALREADY_STARTED', 'A consulta já começou: não pode mais ser cancelada, remarcada nem confirmada.');
}

function outcomeConflict(outcome: AppointmentOutcomeRecord): AppointmentRuleViolation {
  return new AppointmentRuleViolation(
    'APPOINTMENT_OUTCOME_CONFLICT',
    `Esta consulta já tem desfecho registrado ("${outcome.outcome}"); ele não é sobrescrito.`,
  );
}

/**
 * K2-b — a comunicação que encerra a consulta, registrada pela pessoa no
 * painel. Quem pediu é obrigatório: não é inventado (DP-25).
 */
async function recordPanelNotice(
  clinicRepo: ClinicRepository,
  appointment: Appointment,
  intent: 'pedido_cancelamento' | 'pedido_remarcacao',
  input: NoticeInput,
  userId: string,
  now: Date,
): Promise<AppointmentNotice> {
  if (!input.requestedBy) {
    throw new BadRequestException({ code: 'REQUESTED_BY_REQUIRED', message: 'Informe quem pediu: paciente, clínica ou profissional.', category: 'validation' });
  }
  const clinic = await clinicRepo.findByTenantId(appointment.tenantId);
  return AppointmentNotice.recordFromPanel({
    id: randomUUID(),
    appointment,
    intent,
    requestedBy: input.requestedBy,
    reason: input.reason,
    recordedByUserId: userId,
    now,
    cancellationLimitHours: clinic?.cancellationHoursLimit,
  });
}

export interface RescheduleResult {
  previous: Appointment;
  current: Appointment;
  outcome: AppointmentOutcomeRecord | null;
}

/**
 * RemarcarConsultaUseCase — RF-052; T5 da ADR-0069.
 *
 * ADR-0040 (PD-001): consulta o Motor de Disponibilidade para o NOVO
 * horário antes de reagendar. A ocorrência sendo remarcada é excluída da
 * checagem de conflito.
 *
 * K2-b (ADR-0069, seção 5, alternativa C) — a remarcação não move mais o
 * horário da mesma linha: numa só transação, a ocorrência atual vai a
 * `Cancelada` (libera o horário, e é o que a versão anterior entende), o
 * desfecho `Remarcada` é gravado com a comunicação que o justificou, e uma
 * ocorrência nova nasce `Reservada`, ligada à anterior. A ordem é a do banco:
 * o retrato do desfecho só aceita a consulta já cancelada. O id muda; a
 * resposta traz as duas. Só antes do início previsto.
 */
@Injectable()
export class RemarcarConsultaUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository,
    @Inject(APPOINTMENT_OUTCOME_REPOSITORY) private readonly outcomes: AppointmentOutcomeRepository,
    @Inject(APPOINTMENT_NOTICE_REPOSITORY) private readonly notices: AppointmentNoticeRepository,
    @Inject(CLINIC_REPOSITORY) private readonly clinicRepo: ClinicRepository,
    private readonly verificarDisponibilidade: VerificarDisponibilidadeUseCase,
    private readonly auditService: AuditService,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(id: string, newScheduledAt: Date, input: NoticeInput = {}, options?: AppointmentActionOptions): Promise<RescheduleResult> {
    const byAi = options?.actor === 'ai_agent';
    const userId = byAi ? null : requireHumanActor(this.tenantContext);
    return withAppointmentRules(() =>
      this.unitOfWork.run(async () => {
        const now = this.clock.now();
        const { appointment: previous, outcome: existing } = await loadForTransition(this.repo, this.outcomes, id, options);
        if (existing) {
          throw existing.outcome === 'Remarcada'
            ? new AppointmentRuleViolation('APPOINTMENT_ALREADY_RESCHEDULED', 'Esta consulta já foi remarcada; use a ocorrência nova.')
            : outcomeConflict(existing);
        }
        if (previous.state === 'Cancelada' && (await this.repo.findSuccessorId(previous.id))) {
          throw new AppointmentRuleViolation('APPOINTMENT_ALREADY_RESCHEDULED', 'Esta consulta já foi remarcada; use a ocorrência nova.');
        }
        if (previous.hasStarted(now)) throw alreadyStarted();

        const disponivel = await this.verificarDisponibilidade.execute({
          therapistId: previous.therapistId,
          scheduledAt: newScheduledAt,
          excludeAppointmentId: previous.id,
        });
        if (!disponivel) {
          throw new SlotNotAvailableError();
        }

        const events: DomainEvent[] = [];
        let notice: AppointmentNotice | null = null;
        if (userId) {
          notice = await recordPanelNotice(this.clinicRepo, previous, 'pedido_remarcacao', input, userId, now);
          await this.notices.insert(notice);
          events.push(...notice.pullDomainEvents());
        }

        previous.transitionTo('Cancelada');
        await this.repo.save(previous);

        const current = Appointment.rescheduledFrom(previous, { id: randomUUID(), scheduledAt: newScheduledAt });
        let outcome: AppointmentOutcomeRecord | null = null;
        if (notice && userId) {
          outcome = AppointmentOutcomeRecord.closeByNotice(previous, notice, 'Remarcada', { userId, now, newAppointmentId: current.id });
          await this.outcomes.insert(outcome);
        }
        await this.repo.save(current); // pode lançar SESSION_CONFLICT (índice único parcial)

        events.push(...previous.pullDomainEvents(), ...(outcome?.pullDomainEvents() ?? []), ...current.pullDomainEvents());
        await this.auditService.recordAll(events);
        return { previous, current, outcome };
      }),
    );
  }
}

/**
 * CancelarConsultaUseCase — RF-053; T3 da ADR-0069.
 *
 * K2-b — só antes do início previsto. Depois dele, o que houve é realização
 * ou falta (ou aviso tardio, fase seguinte), registrado por pessoa. Pelo
 * painel, a comunicação que justifica o cancelamento é registrada com quem
 * pediu (DP-25) e classificada pelo limite da clínica; o desfecho
 * `Cancelada` congela a consulta. Cancelamento fora do prazo pedido pelo
 * paciente abre a decisão de consequência (DP-22, decisão humana); pedido
 * da clínica ou do profissional nunca abre.
 */
@Injectable()
export class CancelarConsultaUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository,
    @Inject(APPOINTMENT_OUTCOME_REPOSITORY) private readonly outcomes: AppointmentOutcomeRepository,
    @Inject(APPOINTMENT_NOTICE_REPOSITORY) private readonly notices: AppointmentNoticeRepository,
    @Inject(CLINIC_REPOSITORY) private readonly clinicRepo: ClinicRepository,
    private readonly auditService: AuditService,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(id: string, input: NoticeInput = {}, options?: AppointmentActionOptions): Promise<AppointmentActionResult> {
    const byAi = options?.actor === 'ai_agent';
    const userId = byAi ? null : requireHumanActor(this.tenantContext);
    return withAppointmentRules(() =>
      this.unitOfWork.run(async () => {
        const now = this.clock.now();
        const { appointment, outcome: existing } = await loadForTransition(this.repo, this.outcomes, id, options);
        if (existing) {
          // Repetir o cancelamento não muda nada (seção 2.8).
          if (existing.outcome === 'Cancelada') return { appointment, outcome: existing, changed: false };
          throw existing.outcome === 'Remarcada'
            ? new AppointmentRuleViolation('APPOINTMENT_ALREADY_RESCHEDULED', 'Esta consulta já foi remarcada; use a ocorrência nova.')
            : outcomeConflict(existing);
        }
        if (appointment.hasStarted(now) && appointment.state !== 'Cancelada') throw alreadyStarted();

        const events: DomainEvent[] = [];
        let notice: AppointmentNotice | null = null;
        if (userId && appointment.state !== 'Cancelada') {
          notice = await recordPanelNotice(this.clinicRepo, appointment, 'pedido_cancelamento', input, userId, now);
          await this.notices.insert(notice);
          events.push(...notice.pullDomainEvents());
        }

        appointment.transitionTo('Cancelada'); // Cancelada → Cancelada: transição inválida (409)
        await this.repo.save(appointment);

        let outcome: AppointmentOutcomeRecord | null = null;
        if (notice && userId) {
          outcome = AppointmentOutcomeRecord.closeByNotice(appointment, notice, 'Cancelada', { userId, now });
          await this.outcomes.insert(outcome);
        }

        events.push(...appointment.pullDomainEvents(), ...(outcome?.pullDomainEvents() ?? []));
        await this.auditService.recordAll(events);
        return { appointment, outcome, changed: true };
      }),
    );
  }
}

/**
 * ConfirmarConsultaUseCase — RF-054, RN e JP-004; T2 da ADR-0069.
 *
 * K2-b — confirmar é o paciente dizer que vem: muda só o estado de agenda.
 * NÃO cria sessão, nem nada no financeiro. Até aqui a confirmação criava a
 * sessão já `Realizada`, e uma consulta só confirmada podia ser cobrada como
 * atendida (o achado central do MVP-01). O item faturável nasce do desfecho
 * registrado por pessoa depois do início (RegistrarRealizacaoUseCase).
 * Só antes do início previsto.
 */
@Injectable()
export class ConfirmarConsultaUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository,
    @Inject(APPOINTMENT_OUTCOME_REPOSITORY) private readonly outcomes: AppointmentOutcomeRepository,
    private readonly auditService: AuditService,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(id: string, options?: AppointmentActionOptions): Promise<Appointment> {
    return withAppointmentRules(() =>
      this.unitOfWork.run(async () => {
        const { appointment, outcome } = await loadForTransition(this.repo, this.outcomes, id, options);
        if (outcome) throw outcomeConflict(outcome);
        if (appointment.hasStarted(this.clock.now())) throw alreadyStarted();

        appointment.transitionTo('Confirmada');
        await this.repo.save(appointment);
        await this.auditService.recordAll(appointment.pullDomainEvents());
        return appointment;
      }),
    );
  }
}
