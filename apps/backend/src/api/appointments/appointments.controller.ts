import { BadRequestException, Body, Controller, Get, HttpStatus, Param, Post, Patch, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import {
  CancelAppointmentDto,
  CreateAppointmentDto,
  DecisionReasonDto,
  RescheduleAppointmentDto,
  RecurringAppointmentDto,
} from './dto/appointment.dto';
import { ConsultarDisponibilidadeUseCase } from '@use-cases/appointment/consultar-disponibilidade.use-case';
import { AgendarConsultaUseCase } from '@use-cases/appointment/agendar-consulta.use-case';
import {
  RemarcarConsultaUseCase,
  CancelarConsultaUseCase,
  ConfirmarConsultaUseCase,
} from '@use-cases/appointment/gerenciar-consulta.use-case';
import {
  AbonarFaltaUseCase,
  ConfirmarCobrancaDeFaltaUseCase,
  RegistrarFaltaUseCase,
  RegistrarRealizacaoUseCase,
  ReverterAbonoUseCase,
} from '@use-cases/appointment/desfecho-consulta.use-case';
import { CriarAgendamentoRecorrenteUseCase } from '@use-cases/appointment/criar-agendamento-recorrente.use-case';
import { ListarAgendamentosUseCase } from '@use-cases/appointment/listar-agendamentos.use-case';
import { ListarPedidosPeloWhatsAppUseCase, PendingRequestItem } from '@use-cases/appointment/listar-pedidos-pelo-whatsapp.use-case';
import { Appointment } from '@domain/appointment/appointment.entity';
import { AppointmentOutcomeRecord } from '@domain/appointment/appointment-outcome';
import { Session } from '@domain/session/session.entity';

/**
 * AppointmentsController — ver 02 - CTO/clinicos/docs/04-API/01-Contratos-REST.md,
 * seção "Agenda e Agendamento". A rota de disponibilidade fica sob
 * /therapists por decisão já documentada no contrato original.
 *
 * Política de papel por rota: docs/02-Arquitetura/16-Politica-RBAC.md (AD-003).
 *
 * K2-b (ADR-0069, seção 7) — desfechos (realização, falta) e decisões sobre a
 * falta (cobrança, abono, reversão). Uma ação repetida sem efeito responde
 * 200, sem evento novo; a primeira, 201.
 */
/**
 * Tarefa 06 da auditoria (AD-032) — ACHADO REAL: `from` e `to` iam direto
 * para `new Date()`. Ausentes ou inválidos viravam "Invalid Date" e a
 * consulta ao banco respondia erro interno (500). Agora são 400.
 */
function parseDateParam(name: string, value: string | undefined): Date {
  const date = value ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${name} é obrigatório e precisa ser uma data válida (ISO 8601).`);
  }
  return date;
}

/** Repetição sem efeito: 200 em vez do 201 da primeira vez. */
function okWhenUnchanged(res: Response, changed: boolean): void {
  if (!changed) res.status(HttpStatus.OK);
}

function toOutcomeResponse(outcome: AppointmentOutcomeRecord | null) {
  if (!outcome) return null;
  return {
    outcome: outcome.outcome,
    recordedAt: outcome.recordedAt,
    // K11 — `ai_agent`: cancelamento ou remarcação pela IA, confirmado pelo paciente.
    recordedBy: outcome.recordedByActorType,
    noShowDecision: outcome.noShowDecision ?? null,
    lateNoticeDecision: outcome.lateNoticeDecision ?? null,
    noticeTiming: outcome.closingNoticeTiming ?? null,
  };
}

/** K11 — um pedido pelo WhatsApp na lista de pendências; sem o texto da mensagem. */
function toRequestResponse(item: PendingRequestItem) {
  const { request, replies, status, appointment } = item;
  return {
    id: request.id,
    status,
    requestedAction: request.requestedAction ?? null,
    intent: request.intent,
    timing: request.timing,
    receivedAt: request.receivedAt ?? request.recordedAt,
    askedScheduledAt: request.askedScheduledAt ?? null,
    proposedScheduledAt: request.proposedScheduledAt ?? null,
    lastAnswer: replies[replies.length - 1]?.confirmationAnswer ?? null,
    appointment: {
      id: appointment.id,
      patientId: appointment.patientId,
      therapistId: appointment.therapistId,
      scheduledAt: appointment.scheduledAt,
      modality: appointment.modality,
      state: appointment.state,
    },
  };
}

function toSessionResponse(session: Session | null) {
  if (!session) return null;
  return { id: session.id, state: session.state, kind: session.kind ?? null, billingEligibility: session.billingEligibility };
}

function toResponse(appointment: Appointment, outcome: AppointmentOutcomeRecord | null = null) {
  return {
    id: appointment.id,
    patientId: appointment.patientId,
    therapistId: appointment.therapistId,
    scheduledAt: appointment.scheduledAt,
    modality: appointment.modality,
    state: appointment.state,
    recurring: appointment.isRecurring,
    rescheduledFromId: appointment.rescheduledFromId ?? null,
    outcome: toOutcomeResponse(outcome),
  };
}

@ApiTags('appointments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionAccessGuard)
@Controller()
export class AppointmentsController {
  constructor(
    private readonly consultarDisponibilidade: ConsultarDisponibilidadeUseCase,
    private readonly agendarConsulta: AgendarConsultaUseCase,
    private readonly remarcarConsulta: RemarcarConsultaUseCase,
    private readonly cancelarConsulta: CancelarConsultaUseCase,
    private readonly confirmarConsulta: ConfirmarConsultaUseCase,
    private readonly criarAgendamentoRecorrente: CriarAgendamentoRecorrenteUseCase,
    private readonly listarAgendamentos: ListarAgendamentosUseCase,
    private readonly registrarRealizacao: RegistrarRealizacaoUseCase,
    private readonly registrarFalta: RegistrarFaltaUseCase,
    private readonly confirmarCobrancaDeFalta: ConfirmarCobrancaDeFaltaUseCase,
    private readonly abonarFalta: AbonarFaltaUseCase,
    private readonly reverterAbono: ReverterAbonoUseCase,
    private readonly listarPedidosPeloWhatsApp: ListarPedidosPeloWhatsAppUseCase,
  ) {}

  @Get('appointments')
  async list(@Query('from') from: string, @Query('to') to: string) {
    const rows = await this.listarAgendamentos.execute(parseDateParam('from', from), parseDateParam('to', to));
    return { data: rows.map(({ appointment, outcome }) => toResponse(appointment, outcome)) };
  }

  /**
   * K11 (ADR-0069; D6) — pendências da equipe: pedidos de cancelamento ou
   * remarcação pelo WhatsApp aguardando a confirmação do paciente, vencidos
   * ou que precisam de alguém da clínica. O estado é calculado na leitura.
   */
  @Get('appointments/whatsapp-requests')
  @Roles('admin', 'therapist')
  async whatsAppRequests() {
    const items = await this.listarPedidosPeloWhatsApp.execute();
    return { data: items.map(toRequestResponse) };
  }

  @Get('therapists/:id/availability')
  async availability(@Param('id') therapistId: string, @Query('from') from: string, @Query('to') to: string) {
    const slots = await this.consultarDisponibilidade.execute(therapistId, parseDateParam('from', from), parseDateParam('to', to));
    return { data: slots };
  }

  @Post('appointments')
  @Roles('admin', 'therapist')
  async create(@Body() dto: CreateAppointmentDto) {
    const appointment = await this.agendarConsulta.execute({
      ...dto,
      scheduledAt: new Date(dto.scheduledAt),
    });
    return toResponse(appointment);
  }

  /** K2-b — a remarcação cria uma ocorrência nova: a resposta traz a anterior (encerrada) e a atual. */
  @Patch('appointments/:id/reschedule')
  @Roles('admin', 'therapist')
  async reschedule(@Param('id') id: string, @Body() dto: RescheduleAppointmentDto) {
    const result = await this.remarcarConsulta.execute(id, new Date(dto.newScheduledAt), {
      requestedBy: dto.requestedBy,
      reason: dto.reason,
    });
    return { previous: toResponse(result.previous, result.outcome), current: toResponse(result.current) };
  }

  @Post('appointments/:id/cancel')
  @Roles('admin', 'therapist')
  async cancel(@Param('id') id: string, @Body() dto: CancelAppointmentDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.cancelarConsulta.execute(id, { requestedBy: dto.requestedBy, reason: dto.reason });
    okWhenUnchanged(res, result.changed);
    return toResponse(result.appointment, result.outcome);
  }

  @Post('appointments/:id/confirm')
  @Roles('admin', 'therapist')
  async confirm(@Param('id') id: string) {
    return toResponse(await this.confirmarConsulta.execute(id));
  }

  /** T6 — o atendimento aconteceu. Cria ou reaproveita o item faturável `atendimento`. */
  @Post('appointments/:id/attended')
  @Roles('admin', 'therapist')
  async attended(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const result = await this.registrarRealizacao.execute(id);
    okWhenUnchanged(res, result.changed);
    return { ...toResponse(result.appointment, result.outcome), session: toSessionResponse(result.session) };
  }

  /** T7 — o paciente não veio e não avisou. Fica aguardando decisão. */
  @Post('appointments/:id/no-show')
  @Roles('admin', 'therapist')
  async noShow(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const result = await this.registrarFalta.execute(id);
    okWhenUnchanged(res, result.changed);
    return toResponse(result.appointment, result.outcome);
  }

  /** T8 — cobrança da falta confirmada. Cria ou reaproveita o item faturável `falta`. */
  @Post('appointments/:id/no-show/charge')
  @Roles('admin')
  async chargeNoShow(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const result = await this.confirmarCobrancaDeFalta.execute(id);
    okWhenUnchanged(res, result.changed);
    return { ...toResponse(result.appointment, result.outcome), session: toSessionResponse(result.session) };
  }

  /** T9 — abono, com motivo (DP-23). O super_admin é recusado no caso de uso. */
  @Post('appointments/:id/no-show/excuse')
  @Roles('admin')
  async excuseNoShow(
    @Param('id') id: string,
    @Body() dto: DecisionReasonDto,
    @Req() req: Request & { userRole?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.abonarFalta.execute(id, { reason: dto.reason, actorRole: req.userRole });
    okWhenUnchanged(res, result.changed);
    return toResponse(result.appointment, result.outcome);
  }

  /** T9b — reversão do abono, com motivo (DP-24a): volta a aguardar decisão. */
  @Post('appointments/:id/no-show/excuse/revert')
  @Roles('admin')
  async revertExcuse(@Param('id') id: string, @Body() dto: DecisionReasonDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.reverterAbono.execute(id, { reason: dto.reason });
    okWhenUnchanged(res, result.changed);
    return toResponse(result.appointment, result.outcome);
  }

  @Post('appointments/recurring')
  @Roles('admin', 'therapist')
  async recurring(@Body() dto: RecurringAppointmentDto) {
    const appointments = await this.criarAgendamentoRecorrente.execute({
      ...dto,
      firstScheduledAt: new Date(dto.firstScheduledAt),
    });
    return { data: appointments.map((appointment) => toResponse(appointment)) };
  }
}
