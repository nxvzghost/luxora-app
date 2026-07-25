import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateRecurringBlockDto } from './dto/create-recurring-block.dto';
import { RecurringBlockResponseDto } from './dto/recurring-block-response.dto';
import { CriarRecurringBlockUseCase, ListarRecurringBlocksUseCase } from '@use-cases/availability/gerenciar-recurring-block.use-case';

/**
 * RecurringBlocksController — PD-001 Fase 2, C5. Controller próprio,
 * deliberadamente separado de `AppointmentsController` (decisão
 * arquitetural registrada: evitar um Controller único concentrando toda a
 * Agenda, deixar o Bounded Context Availability preparado para crescer —
 * edição/pausa/cancelamento futuros ficam aqui, não em Appointments).
 *
 * Fino por design: só recebe HTTP, valida DTO, chama o Caso de Uso, converte
 * para Response DTO — nenhuma regra de negócio, nenhuma transformação
 * complexa. Materialização (C3) não é acionada automaticamente na criação —
 * permanece desacoplada, fora do escopo desta etapa.
 *
 * Política de papel por rota: docs/02-Arquitetura/16-Politica-RBAC.md (AD-003).
 */
@ApiTags('recurring-blocks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionAccessGuard)
@Controller('recurring-blocks')
export class RecurringBlocksController {
  constructor(
    private readonly criarRecurringBlock: CriarRecurringBlockUseCase,
    private readonly listarRecurringBlocks: ListarRecurringBlocksUseCase,
  ) {}

  @Post()
  @Roles('admin', 'therapist')
  async create(@Body() dto: CreateRecurringBlockDto): Promise<RecurringBlockResponseDto> {
    const block = await this.criarRecurringBlock.execute({
      ...dto,
      firstOccurrence: new Date(dto.firstOccurrence),
    });
    return RecurringBlockResponseDto.fromDomain(block);
  }

  @Get()
  async list(@Query('therapistId') therapistId: string): Promise<{ data: RecurringBlockResponseDto[] }> {
    const blocks = await this.listarRecurringBlocks.execute(therapistId);
    return { data: blocks.map(RecurringBlockResponseDto.fromDomain) };
  }
}
