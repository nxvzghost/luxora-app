import { Injectable, Logger } from '@nestjs/common';
import { IntentResult } from '@domain-services/ai/ai-provider';
import { AgendarConsultaUseCase } from '@use-cases/appointment/agendar-consulta.use-case';
import { CancelarConsultaUseCase, ConfirmarConsultaUseCase } from '@use-cases/appointment/gerenciar-consulta.use-case';
import { ConsultarCobrancaUseCase } from '@use-cases/billing/billing.use-cases';

export interface IntentActionResult {
  actionTaken: boolean;
  actionSummary?: string;
  error?: string;
}

/**
 * IntentActionRouter — Módulo 12, fecha o gap do ADR-0033.
 *
 * Único lugar do sistema que traduz um `intent` (já interpretado pela IA)
 * em chamada real a um Caso de Uso — o elo final do fluxo
 * "IA → Motor Operacional → Caso de Uso" (ADR-0006).
 *
 * REGRA DE SEGURANÇA, não negociável: só executa ação quando TODAS as
 * entidades necessárias estão presentes e em formato válido. Entidade
 * faltando NUNCA vira tentativa de ação "quebrada" — vira
 * `actionTaken: false`, tratado como equivalente a precisar de mais
 * informação. A IA nunca "adivinha" um ID de agendamento ou terapeuta.
 *
 * ESCOPO DESTA IMPLEMENTAÇÃO: 4 intents roteados de verdade
 * (agendar_consulta, cancelar_consulta, confirmar_presenca,
 * consultar_cobranca). `duvida_geral`, `enviar_comprovante`, `outro`
 * permanecem apenas conversacionais — registrado como próximo passo, não
 * crítico como as ações que mutam dado.
 */
@Injectable()
export class IntentActionRouter {
  private readonly logger = new Logger(IntentActionRouter.name);

  constructor(
    private readonly agendarConsulta: AgendarConsultaUseCase,
    private readonly cancelarConsulta: CancelarConsultaUseCase,
    private readonly confirmarConsulta: ConfirmarConsultaUseCase,
    private readonly consultarCobranca: ConsultarCobrancaUseCase,
  ) {}

  async route(intent: IntentResult, context: { tenantId: string; patientId?: string }): Promise<IntentActionResult> {
    try {
      switch (intent.intent) {
        case 'agendar_consulta':
          return await this.routeAgendarConsulta(intent, context);
        case 'cancelar_consulta':
          return await this.routeCancelarConsulta(intent);
        case 'confirmar_presenca':
          return await this.routeConfirmarConsulta(intent);
        case 'consultar_cobranca':
          return await this.routeConsultarCobranca(intent);
        default:
          return { actionTaken: false };
      }
    } catch (err) {
      this.logger.warn(`Falha ao rotear intent "${intent.intent}": ${(err as Error).message}`);
      return { actionTaken: false, error: (err as Error).message };
    }
  }

  private async routeAgendarConsulta(
    intent: IntentResult,
    context: { tenantId: string; patientId?: string },
  ): Promise<IntentActionResult> {
    const { therapistId, scheduledAt, modality } = intent.entities as {
      therapistId?: string;
      scheduledAt?: string;
      modality?: 'presencial' | 'online';
    };

    if (!context.patientId || !therapistId || !scheduledAt) {
      return { actionTaken: false };
    }

    const appointment = await this.agendarConsulta.execute({
      patientId: context.patientId,
      therapistId,
      scheduledAt: new Date(scheduledAt),
      modality: modality ?? 'presencial',
    });

    return {
      actionTaken: true,
      actionSummary: `Consulta agendada para ${appointment.scheduledAt.toLocaleString('pt-BR')}.`,
    };
  }

  private async routeCancelarConsulta(intent: IntentResult): Promise<IntentActionResult> {
    const { appointmentId } = intent.entities as { appointmentId?: string };
    if (!appointmentId) return { actionTaken: false };

    await this.cancelarConsulta.execute(appointmentId);
    return { actionTaken: true, actionSummary: 'Consulta cancelada.' };
  }

  private async routeConfirmarConsulta(intent: IntentResult): Promise<IntentActionResult> {
    const { appointmentId } = intent.entities as { appointmentId?: string };
    if (!appointmentId) return { actionTaken: false };

    await this.confirmarConsulta.execute(appointmentId);
    return { actionTaken: true, actionSummary: 'Presença confirmada.' };
  }

  private async routeConsultarCobranca(intent: IntentResult): Promise<IntentActionResult> {
    const { billingId } = intent.entities as { billingId?: string };
    if (!billingId) return { actionTaken: false };

    const billing = await this.consultarCobranca.execute(billingId);
    return {
      actionTaken: true,
      actionSummary: `Cobrança de R$ ${billing.amount.toFixed(2)}, status: ${billing.state}.`,
    };
  }
}
