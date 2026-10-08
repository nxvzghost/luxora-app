import { BadRequestException, Body, Controller, Get, Param, Post, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateAppointmentDto, RescheduleAppointmentDto, RecurringAppointmentDto } from './dto/appointment.dto';
import { ConsultarDisponibilidadeUseCase } from '@use-cases/appointment/consultar-disponibilidade.use-case';
import { AgendarConsultaUseCase } from '@use-cases/appointment/agendar-consulta.use-case';
import {
  RemarcarConsultaUseCase,
  CancelarConsultaUseCase,
  ConfirmarConsultaUseCase,
} from '@use-cases/appointment/gerenciar-consulta.use-case';
import { CriarAgendamentoRecorrenteUseCase } from '@use-cases/appointment/criar-agendamento-recorrente.use-case';
import { ListarAgendamentosUseCase } from '@use-cases/appointment/listar-agendamentos.use-case';
import { Appointment } from '@domain/appointment/appointment.entity';

/**
 * AppointmentsController — ver 02 - CTO/clinicos/docs/04-API/01-Contratos-REST.md,
 * seção "Agenda e Agendamento". A rota de disponibilidade fica sob
 * /therapists por decisão já documentada no contrato original.
 *
 * Política de papel por rota: docs/02-Arquitetura/16-Politica-RBAC.md (AD-003).
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
  ) {}

  @Get('appointments')
  async list(@Query('from') from: string, @Query('to') to: string) {
    const appointments = await this.listarAgendamentos.execute(parseDateParam('from', from), parseDateParam('to', to));
    return { data: appointments.map(this.toResponse) };
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
    return this.toResponse(appointment);
  }

  @Patch('appointments/:id/reschedule')
  @Roles('admin', 'therapist')
  async reschedule(@Param('id') id: string, @Body() dto: RescheduleAppointmentDto) {
    const appointment = await this.remarcarConsulta.execute(id, new Date(dto.newScheduledAt));
    return this.toResponse(appointment);
  }

  @Post('appointments/:id/cancel')
  @Roles('admin', 'therapist')
  async cancel(@Param('id') id: string) {
    return this.toResponse(await this.cancelarConsulta.execute(id));
  }

  @Post('appointments/:id/confirm')
  @Roles('admin', 'therapist')
  async confirm(@Param('id') id: string) {
    return this.toResponse(await this.confirmarConsulta.execute(id));
  }

  @Post('appointments/recurring')
  @Roles('admin', 'therapist')
  async recurring(@Body() dto: RecurringAppointmentDto) {
    const appointments = await this.criarAgendamentoRecorrente.execute({
      ...dto,
      firstScheduledAt: new Date(dto.firstScheduledAt),
    });
    return { data: appointments.map(this.toResponse) };
  }

  private toResponse(appointment: Appointment) {
    return {
      id: appointment.id,
      patientId: appointment.patientId,
      therapistId: appointment.therapistId,
      scheduledAt: appointment.scheduledAt,
      state: appointment.state,
      recurring: appointment.isRecurring,
    };
  }
}
