import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { ListarSessoesUseCase } from '@use-cases/session/listar-sessoes.use-case';
import { SessionState } from '@domain/session/session.entity';

const SESSION_STATES: SessionState[] = ['Realizada', 'Faturada', 'Recebida'];
const MAX_LIMIT = 200;

/**
 * SessionsController — Tarefa 05 da auditoria. Só leitura.
 *
 * GET /sessions lista as sessões da clínica, com a data da consulta que
 * originou cada uma. `state=Realizada` devolve as que ainda não foram
 * cobradas — é o que a tela de cobrança precisa para montar `sessionIds`.
 * Mesmos guards das demais rotas financeiras de leitura (GET /billings).
 */
@ApiTags('sessions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionAccessGuard)
@Controller('sessions')
export class SessionsController {
  constructor(private readonly listarSessoes: ListarSessoesUseCase) {}

  @Get()
  async list(@Query('state') state?: string, @Query('patientId') patientId?: string, @Query('limit') limit?: string) {
    if (state !== undefined && !SESSION_STATES.includes(state as SessionState)) {
      throw new BadRequestException(`state precisa ser um destes: ${SESSION_STATES.join(', ')}.`);
    }
    const parsedLimit = limit === undefined ? MAX_LIMIT : Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_LIMIT) {
      throw new BadRequestException(`limit precisa ser um inteiro entre 1 e ${MAX_LIMIT}.`);
    }

    const sessions = await this.listarSessoes.execute({
      state: state as SessionState | undefined,
      patientId: patientId || undefined,
      limit: parsedLimit,
    });
    return { data: sessions };
  }
}
