import { Body, Controller, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { CreateTherapistDto, UpdateTherapistDto, SetAvailabilityDto } from './dto/therapist.dto';
import {
  CadastrarTerapeutaUseCase,
  ConsultarTerapeutaUseCase,
  ListarTerapeutasUseCase,
  AtualizarTerapeutaUseCase,
  DefinirDisponibilidadeUseCase,
} from '@use-cases/therapist/therapist.use-cases';
import { Therapist } from '@domain/therapist/therapist.entity';

@ApiTags('therapists')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SubscriptionAccessGuard)
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
  async create(@Body() dto: CreateTherapistDto) {
    const therapist = await this.cadastrarTerapeuta.execute(dto);
    return this.toResponse(therapist);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.toResponse(await this.consultarTerapeuta.execute(id));
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateTherapistDto) {
    const therapist = await this.atualizarTerapeuta.execute({ id, ...dto });
    return this.toResponse(therapist);
  }

  @Put(':id/availability')
  async setAvailability(@Param('id') id: string, @Body() dto: SetAvailabilityDto) {
    const therapist = await this.definirDisponibilidade.execute(id, dto.slots);
    return this.toResponse(therapist);
  }

  private toResponse(therapist: Therapist) {
    return {
      id: therapist.id,
      name: therapist.name,
      specialty: therapist.specialty ?? null,
      availability: therapist.availability,
    };
  }
}
