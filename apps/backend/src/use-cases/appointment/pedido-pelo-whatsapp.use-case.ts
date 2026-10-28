import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Appointment } from '@domain/appointment/appointment.entity';
import { AppointmentNotice, NoticeConfirmationAnswer, NoticeRequestedAction, RequestIntent } from '@domain/appointment/appointment-notice';
import { deriveRequestStatus } from '@domain/appointment/appointment-request';
import { Notification } from '@domain/notification/notification.entity';
import { civilDateIn, formatCivilDate, instantAt, localDateTime } from '@domain/shared/time-zone';
import { AppointmentContextForAi, AppointmentForAi, ConfirmationClassification, IntentResult } from '@domain-services/ai/ai-provider';
import { APPOINTMENT_REPOSITORY, AppointmentRepository } from '@domain-services/patient-ops/appointment.repository';
import { APPOINTMENT_OUTCOME_REPOSITORY, AppointmentOutcomeRepository } from '@domain-services/patient-ops/appointment-outcome.repository';
import {
  APPOINTMENT_NOTICE_REPOSITORY,
  AppointmentNoticeRepository,
  AppointmentRequestThread,
} from '@domain-services/patient-ops/appointment-notice.repository';
import { CLINIC_REPOSITORY, ClinicRepository } from '@domain-services/platform/clinic.repository';
import { THERAPIST_REPOSITORY, TherapistRepository } from '@domain-services/platform/therapist.repository';
import { CLINIC_TIME_ZONE_READER, ClinicTimeZoneReader } from '@domain-services/platform/clinic-time-zone.reader';
import { NOTIFICATION_REPOSITORY, NotificationRepository } from '@domain-services/platform/notification.repository';
import { UNIT_OF_WORK, UnitOfWork } from '@domain-services/platform/unit-of-work';
import { CLOCK, Clock } from '@domain-services/platform/clock';
import { AuditService } from '@domain-services/platform/audit.service';
import { VerificarDisponibilidadeUseCase } from '@use-cases/availability/verificar-disponibilidade.use-case';
import { CancelarConsultaUseCase, RemarcarConsultaUseCase } from './gerenciar-consulta.use-case';
import { AppointmentDescription, K11_TEXT, TEAM_NOTICE, TeamReason, describeAppointment, describeSlot } from './pedido-pelo-whatsapp.textos';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Pedidos lidos: um pedido pode esperar até o dia da consulta, que fica até 180 dias à frente. */
export const REQUEST_LOOKBACK_DAYS = 200;
/** Consultas que já começaram há pouco entram na busca: um pedido sobre elas vai para a equipe (aviso depois do início). */
const CANDIDATE_PAST_HOURS = 12;
/** Depois do início, a resposta a um pedido vencido ainda é lida como resposta (confirmação tardia) por este tempo. */
const LATE_REPLY_WINDOW_HOURS = 24;
const CANDIDATE_FUTURE_DAYS = 180;
const MAX_LISTED = 5;
const MAX_FOR_AI = 10;

/** As intenções que abrem um pedido (D7: "não vou conseguir ir" é pedido de cancelamento). */
const REQUEST_INTENTS: Readonly<Record<string, RequestIntent>> = {
  cancelar_consulta: 'pedido_cancelamento',
  nao_comparecer: 'nao_comparecera',
  remarcar_consulta: 'pedido_remarcacao',
};

/** Uma mensagem do WhatsApp, como o worker a recebeu, com a identidade resolvida neste turno (ADR-0063). */
export interface WhatsAppTurn {
  tenantId: string;
  conversationId: string;
  /** WAMID — uma comunicação por mensagem. */
  messageId: string;
  receivedAt: Date;
  /** O paciente que o número identifica, só quando identifica exatamente um e a identidade está resolvida. */
  patientId?: string;
  identityResolved: boolean;
}

interface PendingRequest {
  thread: AppointmentRequestThread;
  appointment: Appointment;
  /** A consulta mudou depois da pergunta (D4): a resposta é registrada, nada é executado e a equipe é avisada. */
  changed: boolean;
  /** Esta mensagem já foi registrada como resposta (reprocessamento): vale o que foi registrado, não uma nova classificação. */
  replayed?: AppointmentNotice;
}

export interface PreparedTurn {
  /** O que vai para interpretIntent: consultas futuras sem identificadores e a pergunta pendente (D3). */
  context?: AppointmentContextForAi;
  pending: PendingRequest | null;
  /** Há um pedido pendente na conversa, mas o número não identifica mais o mesmo paciente: o turno vai para a equipe. */
  identityChanged?: boolean;
}

export interface K11TurnResult {
  /** Texto montado pelo backend e enviado como está (D4, D8). */
  responseMessage: string;
  actionTaken: boolean;
}

interface Hints {
  date?: string;
  time?: string;
  professional?: string;
}

/**
 * PedidoDeConsultaPeloWhatsAppUseCase — K11 (ADR-0069, seção 10.1, rodada 5;
 * decisões D1 a D8 de 23/10/2026).
 *
 * Cancelar ou remarcar pelo WhatsApp acontece em duas etapas:
 *   1. Pedido: a IA interpreta a intenção e extrai do texto data, horário e
 *      profissional; o backend localiza a consulta entre as do paciente
 *      (D3), confere a disponibilidade do horário novo (D5), registra o
 *      pedido como comunicação e responde com a pergunta de confirmação,
 *      montada aqui com os dados do banco. A consulta não muda.
 *   2. Resposta: em outra mensagem, da mesma conversa, a IA classifica a
 *      resposta diante da pergunta pendente; o backend a registra ligada ao
 *      pedido (D2) e só executa com `confirma`, antes do início, do mesmo
 *      paciente, com a consulta igual à perguntada (D4). A execução grava o
 *      desfecho de autoria `ai_agent` (D1) na mesma transação.
 *
 * Recusa, resposta ambígua, confirmação tardia, consulta mudada, horário
 * ocupado, pedido depois do início e identidade alterada não executam nada e
 * avisam a equipe pelo painel. O vencimento é conferido quando chega uma
 * mensagem na conversa e quando a equipe lista as pendências, sem agendador
 * (D6). Nenhum texto fala em cobrança (D8).
 */
@Injectable()
export class PedidoDeConsultaPeloWhatsAppUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointments: AppointmentRepository,
    @Inject(APPOINTMENT_OUTCOME_REPOSITORY) private readonly outcomes: AppointmentOutcomeRepository,
    @Inject(APPOINTMENT_NOTICE_REPOSITORY) private readonly notices: AppointmentNoticeRepository,
    @Inject(CLINIC_REPOSITORY) private readonly clinics: ClinicRepository,
    @Inject(THERAPIST_REPOSITORY) private readonly therapists: TherapistRepository,
    @Inject(CLINIC_TIME_ZONE_READER) private readonly clinicTimeZone: ClinicTimeZoneReader,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly auditService: AuditService,
    private readonly verificarDisponibilidade: VerificarDisponibilidadeUseCase,
    private readonly cancelarConsulta: CancelarConsultaUseCase,
    private readonly remarcarConsulta: RemarcarConsultaUseCase,
  ) {}

  /**
   * Antes de interpretIntent: o pedido pendente da conversa e, para o
   * paciente identificado, o contexto da IA. Pendente é o pedido mais novo
   * da conversa que ainda espera resposta: aguardando; vencido há menos de
   * LATE_REPLY_WINDOW_HOURS (a resposta é tardia); ou com a consulta mudada
   * antes do horário perguntado (a resposta vai para a equipe). Um pedido
   * vencido ou com a identidade mudada avisa a equipe (uma vez).
   */
  async prepare(turn: WhatsAppTurn): Promise<PreparedTurn> {
    const now = this.clock.now();
    const timeZone = await this.clinicTimeZone.current();
    const names = await this.therapistNames();

    const threads = await this.notices.findRequests({ since: new Date(now.getTime() - REQUEST_LOOKBACK_DAYS * DAY_MS), conversationId: turn.conversationId });
    const latest = threads[threads.length - 1];
    let pending: PendingRequest | null = null;
    let identityChanged = false;
    if (latest) {
      const appointment = await this.appointments.findById(latest.request.appointmentId);
      const outcome = appointment ? await this.outcomes.findByAppointmentId(appointment.id) : null;
      const status = deriveRequestStatus({ ...latest, appointment, outcome, superseded: false, now });
      const askedAt = latest.request.askedScheduledAt?.getTime() ?? 0;
      const replayed = latest.replies.find((reply) => reply.messageId === turn.messageId);
      const changed = replayed
        ? replayed.confirmationAnswer === 'confirma' && replayed.isBeforeStart && replayed.reviewStatus === 'pendente'
        : status === 'sem_efeito' && latest.replies.length === 0 && askedAt > now.getTime();
      const open =
        status === 'aguardando' || (status === 'vencido' && now.getTime() < askedAt + LATE_REPLY_WINDOW_HOURS * HOUR_MS) || changed || !!replayed;
      if (appointment && open) {
        if (status === 'vencido') {
          await this.notifyTeam('vencido', appointment, latest.request, names, timeZone);
        }
        if (turn.identityResolved && turn.patientId === latest.request.patientId) {
          pending = { thread: latest, appointment, changed, replayed };
        } else {
          // ADR-0063 — sem o mesmo paciente identificado, a resposta não é lida como confirmação.
          identityChanged = true;
          await this.notifyTeam('identidade_alterada', appointment, latest.request, names, timeZone);
        }
      }
    }

    if (!turn.identityResolved || !turn.patientId) return { pending: null, identityChanged };

    const upcoming = (await this.openCandidates(turn.patientId, now)).filter((a) => !a.hasStarted(now)).slice(0, MAX_FOR_AI);
    return {
      context: {
        today: `${formatCivilDate(civilDateIn(now, timeZone))} (${weekdayOf(now, timeZone)})`,
        upcoming: upcoming.map((a) => this.forAi(a, names, timeZone)),
        pendingQuestion: pending ? this.question(pending.thread.request, this.describeAsked(pending.thread.request, pending.appointment, names, timeZone), timeZone) : undefined,
      },
      pending,
      identityChanged,
    };
  }

  /**
   * Depois de interpretIntent: responde a um pedido pendente ou abre um novo.
   * `null` quando a mensagem não é do K11 (o turno segue o fluxo de sempre).
   */
  async handle(turn: WhatsAppTurn, intent: IntentResult, prepared: PreparedTurn): Promise<K11TurnResult | null> {
    if (!turn.identityResolved || !turn.patientId) return null;
    // Pedido pendente de outro paciente nesta conversa: nada é executado neste turno (nem por outro caminho).
    if (prepared.identityChanged) return answered(K11_TEXT.handedToTeam());

    if (prepared.pending && (prepared.pending.replayed || intent.confirmation !== 'nao_relacionada')) {
      // Sem classificação válida, ou com escalonamento pedido pela própria IA, a resposta não vale como confirmação.
      const answer = !intent.confirmation || intent.confirmation === 'nao_relacionada' || intent.requiresEscalation ? 'ambigua' : intent.confirmation;
      const replied = await this.handleReply(turn, prepared.pending, answer);
      if (replied) return replied;
    }
    const requestIntent = REQUEST_INTENTS[intent.intent];
    if (requestIntent && !intent.requiresEscalation) {
      return this.handleRequest(turn, requestIntent, intent.entities ?? {});
    }
    return null;
  }

  private async handleRequest(turn: WhatsAppTurn, requestIntent: RequestIntent, entities: Record<string, unknown>): Promise<K11TurnResult | null> {
    const now = this.clock.now();
    const timeZone = await this.clinicTimeZone.current();
    const names = await this.therapistNames();
    const patientId = turn.patientId as string;

    // Reentrega ou reprocessamento da mesma mensagem: o pedido já existe, e a pergunta é repetida como foi feita.
    const existing = await this.notices.findByMessageId(turn.messageId);
    if (existing) {
      const asked = existing.awaitsConfirmation ? await this.appointments.findById(existing.appointmentId) : null;
      return asked ? answered(this.question(existing, this.describeAsked(existing, asked, names, timeZone), timeZone)) : null;
    }

    const candidates = await this.openCandidates(patientId, now);
    const future = candidates.filter((a) => !a.hasStarted(now));
    if (candidates.length === 0) return answered(K11_TEXT.noAppointment());

    const matches = matchAppointments(candidates, readHints(entities), names, timeZone);
    if (matches.length !== 1) {
      const listed = (matches.length > 1 ? matches : future).slice(0, MAX_LISTED);
      if (listed.length === 0) return answered(K11_TEXT.noAppointment());
      const list = listed.map((a) => this.describe(a, names, timeZone).text).join('; ');
      return answered(matches.length > 1 ? K11_TEXT.severalMatches(list) : K11_TEXT.notMatched(list));
    }

    const appointment = matches[0];
    const action: NoticeRequestedAction = requestIntent === 'pedido_remarcacao' ? 'remarcar' : 'cancelar';
    const description = this.describe(appointment, names, timeZone);
    if (appointment.hasStarted(now) || appointment.hasStarted(turn.receivedAt)) {
      // Depois do início não há pedido: o que houve é decisão da equipe (aviso tardio, realização, falta).
      await this.notifyTeam('depois_do_inicio', appointment, { id: appointment.id, action }, names, timeZone);
      return answered(K11_TEXT.alreadyStarted(description));
    }

    let proposed: Date | undefined;
    if (action === 'remarcar') {
      proposed = readNewSlot(entities, timeZone);
      if (!proposed) return answered(K11_TEXT.askNewSlot(description));
      if (proposed.getTime() <= now.getTime()) return answered(K11_TEXT.newSlotInThePast());
      // D5 — conferido agora e de novo na confirmação.
      const available = await this.verificarDisponibilidade.execute({
        therapistId: appointment.therapistId,
        scheduledAt: proposed,
        excludeAppointmentId: appointment.id,
      });
      if (!available) return answered(K11_TEXT.newSlotUnavailable(describeSlot(proposed, timeZone)));
    }

    const request = AppointmentNotice.requestFromWhatsApp({
      id: randomUUID(),
      appointment,
      intent: requestIntent,
      proposedScheduledAt: proposed,
      message: { conversationId: turn.conversationId, messageId: turn.messageId, receivedAt: turn.receivedAt },
      now,
      cancellationLimitHours: (await this.clinics.findByTenantId(turn.tenantId))?.cancellationHoursLimit,
    });
    await this.record(request);
    return answered(this.question(request, description, timeZone));
  }

  /**
   * A resposta à pergunta pendente. `null` quando a mensagem não pode ser
   * resposta (D4): é a do próprio pedido, ou chegou antes dele, ou já foi
   * registrada como outra coisa — o turno segue como pedido, se for um.
   */
  private async handleReply(
    turn: WhatsAppTurn,
    pending: PendingRequest,
    classified: Exclude<ConfirmationClassification, 'nao_relacionada'>,
  ): Promise<K11TurnResult | null> {
    const { request } = pending.thread;
    const timeZone = await this.clinicTimeZone.current();
    const names = await this.therapistNames();

    let reply = await this.notices.findByMessageId(turn.messageId);
    if (reply && reply.confirmsNoticeId !== request.id) return null;
    if (!reply) {
      // D4 — mensagem posterior ao pedido, nunca a do próprio pedido.
      if (request.messageId === turn.messageId || !request.receivedAt || turn.receivedAt.getTime() <= request.receivedAt.getTime()) {
        return null;
      }
      if (turn.patientId !== request.patientId) {
        // ADR-0063 — a identidade mudou neste turno (contato associado a outro paciente): não é resposta dele.
        await this.notifyTeam('identidade_alterada', pending.appointment, request, names, timeZone);
        return answered(K11_TEXT.handedToTeam());
      }
      reply = AppointmentNotice.replyFromWhatsApp({
        id: randomUUID(),
        request,
        appointment: pending.appointment,
        answer: classified as NoticeConfirmationAnswer,
        message: { conversationId: turn.conversationId, messageId: turn.messageId, receivedAt: turn.receivedAt },
        now: this.clock.now(),
        cancellationLimitHours: (await this.clinics.findByTenantId(turn.tenantId))?.cancellationHoursLimit,
        needsReview: pending.changed,
      });
      await this.record(reply);
    }

    if (pending.changed) {
      // D4 — a consulta não é mais a perguntada: a resposta fica registrada, e nada é executado.
      await this.notifyTeam('consulta_alterada', pending.appointment, request, names, timeZone);
      return answered(K11_TEXT.changed());
    }
    const current = this.describe(pending.appointment, names, timeZone);
    if (reply.confirmationAnswer === 'recusa') {
      await this.notifyTeam('recusa', pending.appointment, request, names, timeZone);
      return answered(K11_TEXT.kept(current));
    }
    if (reply.confirmationAnswer === 'ambigua') {
      await this.notifyTeam('ambigua', pending.appointment, request, names, timeZone);
      return answered(K11_TEXT.unclear());
    }
    if (!reply.isBeforeStart) {
      await this.notifyTeam('tardia', pending.appointment, request, names, timeZone);
      return answered(K11_TEXT.tooLate());
    }
    return this.execute(turn, request, reply, pending.appointment, names, timeZone);
  }

  /** A execução, numa transação do caso de uso de cancelar ou remarcar, que confere tudo de novo com a consulta travada. */
  private async execute(
    turn: WhatsAppTurn,
    request: AppointmentNotice,
    confirmation: AppointmentNotice,
    appointment: Appointment,
    names: Map<string, string>,
    timeZone: string,
  ): Promise<K11TurnResult> {
    const previous = this.describe(appointment, names, timeZone);
    const options = { expectedPatientId: turn.patientId, actor: 'ai_agent' as const, aiConfirmation: { request, confirmation } };
    try {
      if (request.requestedAction === 'cancelar') {
        const result = await this.cancelarConsulta.execute(request.appointmentId, {}, options);
        if (result.outcome?.closingNoticeId === request.id) {
          return { responseMessage: K11_TEXT.cancelled(previous), actionTaken: result.changed };
        }
        // Cancelada por outro caminho (painel) entre a pergunta e a resposta.
        return this.teamTakesOver('consulta_alterada', appointment, request, names, timeZone, K11_TEXT.changed());
      }
      const result = await this.remarcarConsulta.execute(request.appointmentId, request.proposedScheduledAt as Date, {}, options);
      return { responseMessage: K11_TEXT.rescheduled(describeSlot(result.current.scheduledAt, timeZone), previous), actionTaken: true };
    } catch (err) {
      const code = errorCode(err);
      if (code === 'APPOINTMENT_ALREADY_RESCHEDULED' || code === 'APPOINTMENT_OUTCOME_CONFLICT') {
        // A mesma confirmação de novo (reentrega): o desfecho já é deste pedido.
        const outcome = await this.outcomes.findByAppointmentId(request.appointmentId);
        if (outcome?.closingNoticeId === request.id) {
          return {
            responseMessage:
              request.requestedAction === 'cancelar'
                ? K11_TEXT.cancelled(previous)
                : K11_TEXT.rescheduled(describeSlot(request.proposedScheduledAt as Date, timeZone), previous),
            actionTaken: false,
          };
        }
        return this.teamTakesOver('consulta_alterada', appointment, request, names, timeZone, K11_TEXT.changed());
      }
      if (code === 'APPOINTMENT_ALREADY_STARTED') {
        return this.teamTakesOver('tardia', appointment, request, names, timeZone, K11_TEXT.tooLate());
      }
      if (code === 'SLOT_NOT_AVAILABLE' || code === 'SESSION_CONFLICT') {
        return this.teamTakesOver(
          'horario_indisponivel',
          appointment,
          request,
          names,
          timeZone,
          K11_TEXT.slotTakenAtConfirmation(describeSlot(request.proposedScheduledAt as Date, timeZone), previous),
        );
      }
      if (code === 'APPOINTMENT_REQUEST_STALE' || code === 'INVALID_STATE_TRANSITION' || code === 'NOT_FOUND') {
        return this.teamTakesOver('consulta_alterada', appointment, request, names, timeZone, K11_TEXT.changed());
      }
      throw err;
    }
  }

  private async teamTakesOver(
    reason: TeamReason,
    appointment: Appointment,
    request: AppointmentNotice,
    names: Map<string, string>,
    timeZone: string,
    responseMessage: string,
  ): Promise<K11TurnResult> {
    await this.notifyTeam(reason, appointment, request, names, timeZone);
    return answered(responseMessage);
  }

  /** O pedido ou a resposta, com a auditoria, numa transação. A autoria é da IA. */
  private async record(notice: AppointmentNotice): Promise<void> {
    await this.unitOfWork.run(async () => {
      await this.notices.insert(notice);
      await this.auditService.recordAll(notice.pullDomainEvents(), 'ai_agent');
    });
  }

  /**
   * Aviso interno à equipe (as notificações do painel), um por pedido e por
   * motivo enquanto não for lido. Diz a consulta (data, horário,
   * profissional), nunca o nome do paciente nem o texto da mensagem.
   */
  private async notifyTeam(
    reason: TeamReason,
    appointment: Appointment,
    subject: { id: string; requestedAction?: NoticeRequestedAction; action?: NoticeRequestedAction },
    names: Map<string, string>,
    timeZone: string,
  ): Promise<void> {
    const type = `whatsapp_request_${reason}`;
    if (await this.notifications.hasUnread(type, subject.id)) return;
    const action = subject.requestedAction ?? subject.action ?? 'cancelar';
    const notice = TEAM_NOTICE[reason];
    await this.notifications.create(
      Notification.create({
        id: randomUUID(),
        tenantId: appointment.tenantId,
        type,
        title: notice.title,
        message: notice.message(this.describe(appointment, names, timeZone).text, action),
        entityType: subject.requestedAction ? 'AppointmentNotice' : 'Appointment',
        entityId: subject.id,
      }),
    );
  }

  /** Consultas abertas do paciente, sem desfecho, das que começaram há pouco até 180 dias à frente. */
  private async openCandidates(patientId: string, now: Date): Promise<Appointment[]> {
    const open = await this.appointments.findOpenByPatientAndRange(
      patientId,
      new Date(now.getTime() - CANDIDATE_PAST_HOURS * HOUR_MS),
      new Date(now.getTime() + CANDIDATE_FUTURE_DAYS * DAY_MS),
    );
    const outcomes = await this.outcomes.findByAppointmentIds(open.map((a) => a.id));
    return open.filter((a) => !outcomes.has(a.id));
  }

  private question(request: AppointmentNotice, description: AppointmentDescription, timeZone: string): string {
    return request.requestedAction === 'remarcar'
      ? K11_TEXT.askReschedule(description, describeSlot(request.proposedScheduledAt as Date, timeZone))
      : K11_TEXT.askCancel(description);
  }

  private describe(appointment: Appointment, names: Map<string, string>, timeZone: string): AppointmentDescription {
    return describeAppointment(appointment.scheduledAt, names.get(appointment.therapistId) ?? 'o profissional', appointment.modality, timeZone);
  }

  /** A consulta como foi perguntada (o retrato do pedido), mesmo que ela tenha mudado depois. */
  private describeAsked(request: AppointmentNotice, appointment: Appointment, names: Map<string, string>, timeZone: string): AppointmentDescription {
    return describeAppointment(
      request.askedScheduledAt ?? appointment.scheduledAt,
      names.get(appointment.therapistId) ?? 'o profissional',
      request.askedModality ?? appointment.modality,
      timeZone,
    );
  }

  private forAi(appointment: Appointment, names: Map<string, string>, timeZone: string): AppointmentForAi {
    const local = localDateTime(appointment.scheduledAt, timeZone);
    return {
      date: formatCivilDate(local),
      weekday: weekdayOf(appointment.scheduledAt, timeZone),
      time: `${pad2(local.hour)}:${pad2(local.minute)}`,
      professional: names.get(appointment.therapistId) ?? 'profissional da clínica',
      modality: appointment.modality,
    };
  }

  private async therapistNames(): Promise<Map<string, string>> {
    return new Map((await this.therapists.findAllByTenant()).map((t) => [t.id, t.name]));
  }
}

function answered(responseMessage: string): K11TurnResult {
  return { responseMessage, actionTaken: false };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function weekdayOf(instant: Date, timeZone: string): string {
  return instant.toLocaleDateString('pt-BR', { weekday: 'long', timeZone });
}

/** O código de erro da API (`{ code }`), ou NOT_FOUND para a consulta que não é mais legível. */
function errorCode(err: unknown): string | undefined {
  if (err instanceof NotFoundException) return 'NOT_FOUND';
  if (err instanceof HttpException) {
    const body = err.getResponse();
    if (typeof body === 'object' && body !== null && 'code' in body) return String((body as { code: unknown }).code);
  }
  return undefined;
}

function normalizeName(value: string): string[] {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((token) => token && !['dr', 'dra', 'doutor', 'doutora', 'prof', 'profa', 'com', 'a', 'o', 'de', 'da', 'do'].includes(token));
}

/** Cada palavra do que o paciente disse aparece no nome do profissional ("Paula" casa com "Dra. Paula Souza"). */
function sameProfessional(name: string, hint: string): boolean {
  const said = normalizeName(hint);
  const tokens = new Set(normalizeName(name));
  return said.length > 0 && said.every((token) => tokens.has(token));
}

/** D3 — o que a IA extraiu do texto, validado: nada fora do formato entra na busca. */
export function readHints(entities: Record<string, unknown>): Hints {
  const text = (key: string) => (typeof entities[key] === 'string' ? (entities[key] as string).trim() : '');
  const date = text('appointmentDate');
  const time = normalizeTime(text('appointmentTime'));
  const professional = text('professional');
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
    time,
    professional: professional && professional.length <= 80 ? professional : undefined,
  };
}

function normalizeTime(value: string): string | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? `${pad2(hour)}:${pad2(minute)}` : undefined;
}

/** O horário novo pedido, no fuso da clínica; indefinido se faltar ou não existir (31/02, 25:00). */
export function readNewSlot(entities: Record<string, unknown>, timeZone: string): Date | undefined {
  const date = typeof entities.newDate === 'string' ? entities.newDate.trim() : '';
  const time = normalizeTime(typeof entities.newTime === 'string' ? entities.newTime.trim() : '');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match || !time) return undefined;
  const day = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const [hour, minute] = time.split(':').map(Number);
  const instant = instantAt(timeZone, day, { hour, minute });
  const local = localDateTime(instant, timeZone);
  return local.year === day.year && local.month === day.month && local.day === day.day ? instant : undefined;
}

/** D3 — as consultas que casam com o que o paciente disse; sem nenhuma indicação, todas. */
export function matchAppointments(candidates: Appointment[], hints: Hints, names: Map<string, string>, timeZone: string): Appointment[] {
  return candidates.filter((appointment) => {
    const local = localDateTime(appointment.scheduledAt, timeZone);
    if (hints.date && hints.date !== formatCivilDate(local)) return false;
    if (hints.time && hints.time !== `${pad2(local.hour)}:${pad2(local.minute)}`) return false;
    if (hints.professional && !sameProfessional(names.get(appointment.therapistId) ?? '', hints.professional)) return false;
    return true;
  });
}
