import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AutomationApiKeyGuard } from './automation-api-key.guard';
import { EnviarResumoAgendaDoDiaUseCase } from '@use-cases/scheduling/enviar-resumo-agenda-do-dia.use-case';
import { ReenviarAgendaAtualizadaUseCase } from '@use-cases/scheduling/reenviar-agenda-atualizada.use-case';
import { ExecutarReguaInadimplenciaUseCase } from '@use-cases/billing/executar-regua-inadimplencia.use-case';
import { GerarFechamentoMensalUseCase } from '@use-cases/billing/gerar-fechamento-mensal.use-case';

/**
 * AutomationsController — Módulo 14, revisão geral fechando as 2
 * pendências que faltavam: ReenviarAgendaAtualizada e Fechamento Mensal.
 *
 * TESTE DE ACEITE DO ADR-0021: cada handler tem no máximo 2 linhas —
 * recebe input, delega ao Use Case. Nenhuma regra de negócio vive aqui.
 */
@ApiTags('automations')
@UseGuards(AutomationApiKeyGuard)
@Controller('automations')
export class AutomationsController {
  constructor(
    private readonly enviarResumoAgenda: EnviarResumoAgendaDoDiaUseCase,
    private readonly reenviarAgendaAtualizada: ReenviarAgendaAtualizadaUseCase,
    private readonly executarReguaInadimplencia: ExecutarReguaInadimplenciaUseCase,
    private readonly gerarFechamentoMensal: GerarFechamentoMensalUseCase,
  ) {}

  @Post('agenda-summary/send')
  async sendAgendaSummary(@Body() dto: { tenantId: string; therapistId: string; therapistPhone: string }) {
    await this.enviarResumoAgenda.execute(dto.tenantId, dto.therapistId, dto.therapistPhone);
    return { status: 'enqueued' };
  }

  @Post('agenda-summary/resend')
  async resendAgendaSummary(@Body() dto: { tenantId: string; therapistId: string; therapistPhone: string }) {
    await this.reenviarAgendaAtualizada.execute(dto.tenantId, dto.therapistId, dto.therapistPhone);
    return { status: 'enqueued' };
  }

  @Post('inadimplencia/execute')
  async executeOverdueRoutine(@Body() dto: { tenantId: string }) {
    return this.executarReguaInadimplencia.execute(dto.tenantId);
  }

  @Post('fechamento-mensal/generate')
  async generateMonthlyClosing() {
    return this.gerarFechamentoMensal.execute();
  }
}
