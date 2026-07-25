import { Body, Controller, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateTherapistDto, UpdateTherapistDto, SetAvailabilityDto } from './dto/therapist.dto';
import {
  CadastrarTerapeutaUseCase,
  ConsultarTerapeutaUseCase,
  ListarTerapeutasUseCase,
  AtualizarTerapeutaUseCase,
} from '@use-cases/therapist/therapist.use-cases';
import { DefinirDisponibilidadeUseCase } from '@use-cases/availability/gerenciar-disponibilidade.use-case';
import { Therapist } from '@domain/therapist/therapist.entity';
import { AvailabilityCalendar } from '@domain/availability/availability-calendar.entity';

/**
 * TherapistsController — política de papel por rota: docs/02-Arquitetura/16-Politica-RBAC.md (AD-003).
 */
@ApiTags('therapists')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionAccessGuard)
@Controller('therapists')
export class TherapistsController {
  constructor(
    private readonly cadastrarTerapeuta: CadastrarTerapeutaUseCase,
    private readonly consultarTerapeuta: ConsultarTerapeutaUseCase,
    private readonly listarTerapeutas: ListarTerapeutasUseCase,
    private readonly atualizarTerapeuta: AtualizarTerapeutaUseCase,
    private readonly definirDisponibilidade: DefinirDisponibilidadeUseCase,
  ) {}

  @Get()
  async list() {
    const therapists = await this.listarTerapeutas.execute();
    return { data: therapists.map(this.toResponse) };
  }

  @Post()
  @Roles('admin')
  async create(@Body() dto: CreateTherapistDto) {
    const therapist = await this.cadastrarTerapeuta.execute(dto);
    return this.toResponse(therapist);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.toResponse(await this.consultarTerapeuta.execute(id));
  }

  @Patch(':id')
  @Roles('admin')
  async update(@Param('id') id: string, @Body() dto: UpdateTherapistDto) {
    const therapist = await this.atualizarTerapeuta.execute({ id, ...dto });
    return this.toResponse(therapist);
  }

  @Put(':id/availability')
  @Roles('admin')
  async setAvailability(@Param('id') id: string, @Body() dto: SetAvailabilityDto) {
    const calendar = await this.definirDisponibilidade.execute(id, dto.windows);
    return this.toCalendarResponse(calendar);
  }

  private toResponse(therapist: Therapist) {
    return {
      id: therapist.id,
      name: therapist.name,
      specialty: therapist.specialty ?? null,
    };
  }

  private toCalendarResponse(calendar: AvailabilityCalendar) {
    return {
      therapistId: calendar.therapistId,
      windows: calendar.windows,
    };
  }
}
