import { Injectable, Logger } from '@nestjs/common';
import { IntentResult } from '@domain-services/ai/ai-provider';
import { AgendarConsultaUseCase } from '@use-cases/appointment/agendar-consulta.use-case';
import {
  CancelarConsultaUseCase,
  ConfirmarConsultaUseCase,
  RemarcarConsultaUseCase,
} from '@use-cases/appointment/gerenciar-consulta.use-case';
import { ConsultarCobrancaUseCase } from '@use-cases/billing/billing.use-cases';
import { ConsultarDisponibilidadeUseCase } from '@use-cases/appointment/consultar-disponibilidade.use-case';

export interface IntentActionResult {
  actionTaken: boolean;
  actionSummary?: string;
  error?: string;
  /** ADR-0063 (AD-038) — a ação dependia de saber quem é o paciente e isso não estava resolvido. */
  blockedByIdentity?: boolean;
}

export interface IntentActionContext {
  tenantId: string;
  /** O paciente que a conversa identifica — o único em nome de quem uma ação pode ser executada. */
  patientId?: string;
  /**
   * ADR-0063 (AD-038) — `false` quando a identidade está pendente ou
   * ambígua neste turno (número de mais de um paciente, pedido de
   * confirmação, conversa entregue à clínica). Ausente, vale a presença de
   * `patientId`.
   */
  identityResolved?: boolean;
}

/**
 * Ações que só fazem sentido em nome de um paciente: marcar, cancelar,
 * confirmar e remarcar consulta, e consultar cobrança. Consultar horários
 * livres não está aqui — é leitura da agenda da clínica, igual para qualquer
 * pessoa.
 */
const IDENTITY_DEPENDENT_INTENTS: ReadonlySet<string> = new Set([
  'agendar_consulta',
  'cancelar_consulta',
  'confirmar_presenca',
  'consultar_cobranca',
  'remarcar_consulta',
]);

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
 * ESCOPO DESTA IMPLEMENTAÇÃO: 6 intents roteados de verdade
 * (agendar_consulta, cancelar_consulta, confirmar_presenca,
 * consultar_cobranca, remarcar_consulta, consultar_disponibilidade —
 * os 2 últimos adicionados pela AD-010/ADR-0053; os Use Cases já
 * existiam prontos em AppointmentsModule, só não estavam conectados
 * aqui). `duvida_geral`, `enviar_comprovante`, `outro` permanecem apenas
 * conversacionais.
 *
 * ADR-0063 (AD-038) — SEGUNDA REGRA DE SEGURANÇA: nenhuma ação que dependa
 * de quem é o paciente é executada com a identidade pendente ou ambígua, e
 * toda ação sobre uma consulta ou cobrança confere se o registro é do
 * paciente da conversa. O identificador vem da IA; a conferência é do
 * backend. Antes, cancelar, confirmar, remarcar e consultar cobrança agiam
 * sobre qualquer registro da clínica cujo id chegasse nas entidades.
 */
@Injectable()
export class IntentActionRouter {
  private readonly logger = new Logger(IntentActionRouter.name);

  constructor(
    private readonly agendarConsulta: AgendarConsultaUseCase,
    private readonly cancelarConsulta: CancelarConsultaUseCase,
    private readonly confirmarConsulta: ConfirmarConsultaUseCase,
    private readonly consultarCobranca: ConsultarCobrancaUseCase,
    private readonly remarcarConsulta: RemarcarConsultaUseCase,
    private readonly consultarDisponibilidade: ConsultarDisponibilidadeUseCase,
  ) {}

  async route(intent: IntentResult, context: IntentActionContext): Promise<IntentActionResult> {
    if (IDENTITY_DEPENDENT_INTENTS.has(intent.intent) && (context.identityResolved === false || !context.patientId)) {
      return { actionTaken: false, blockedByIdentity: true };
    }
    const patientId = context.patientId as string;

    try {
      switch (intent.intent) {
        case 'agendar_consulta':
          return await this.routeAgendarConsulta(intent, context);
        case 'cancelar_consulta':
          return await this.routeCancelarConsulta(intent, patientId);
        case 'confirmar_presenca':
          return await this.routeConfirmarConsulta(intent, patientId);
        case 'consultar_cobranca':
          return await this.routeConsultarCobranca(intent, patientId);
        case 'remarcar_consulta':
          return await this.routeRemarcarConsulta(intent, patientId);
        case 'consultar_disponibilidade':
          return await this.routeConsultarDisponibilidade(intent);
        default:
          return { actionTaken: false };
      }
    } catch (err) {
      this.logger.warn(`Falha ao rotear intent "${intent.intent}": ${(err as Error).message}`);
      return { actionTaken: false, error: (err as Error).message };
    }
  }

  private async routeAgendarConsulta(intent: IntentResult, context: IntentActionContext): Promise<IntentActionResult> {
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

  // Nas três rotas de consulta abaixo, `expectedPatientId` faz o próprio Caso
  // de Uso recusar (como "não encontrado") a consulta que não é do paciente
  // da conversa — antes de qualquer mudança de estado.
  private async routeCancelarConsulta(intent: IntentResult, patientId: string): Promise<IntentActionResult> {
    const { appointmentId } = intent.entities as { appointmentId?: string };
    if (!appointmentId) return { actionTaken: false };

    await this.cancelarConsulta.execute(appointmentId, { expectedPatientId: patientId });
    return { actionTaken: true, actionSummary: 'Consulta cancelada.' };
  }

  private async routeConfirmarConsulta(intent: IntentResult, patientId: string): Promise<IntentActionResult> {
    const { appointmentId } = intent.entities as { appointmentId?: string };
    if (!appointmentId) return { actionTaken: false };

    await this.confirmarConsulta.execute(appointmentId, { expectedPatientId: patientId });
    return { actionTaken: true, actionSummary: 'Presença confirmada.' };
  }

  private async routeConsultarCobranca(intent: IntentResult, patientId: string): Promise<IntentActionResult> {
    const { billingId } = intent.entities as { billingId?: string };
    if (!billingId) return { actionTaken: false };

    const billing = await this.consultarCobranca.execute(billingId);
    // A cobrança de outro paciente não é lida em voz alta para quem escreve.
    if (billing.patientId !== patientId) return { actionTaken: false };
    return {
      actionTaken: true,
      actionSummary: `Cobrança de R$ ${billing.amount.toFixed(2)}, status: ${billing.state}.`,
    };
  }

  /** AD-010 — RemarcarConsultaUseCase já existia pronto, só não conectado aqui. */
  private async routeRemarcarConsulta(intent: IntentResult, patientId: string): Promise<IntentActionResult> {
    const { appointmentId, newScheduledAt } = intent.entities as { appointmentId?: string; newScheduledAt?: string };
    if (!appointmentId || !newScheduledAt) return { actionTaken: false };

    const appointment = await this.remarcarConsulta.execute(appointmentId, new Date(newScheduledAt), {
      expectedPatientId: patientId,
    });
    return {
      actionTaken: true,
      actionSummary: `Consulta reagendada para ${appointment.scheduledAt.toLocaleString('pt-BR')}.`,
    };
  }

  /**
   * AD-010 — ConsultarDisponibilidadeUseCase já existia pronto, só não
   * conectado aqui. `therapistId` é obrigatório (mesma regra de segurança
   * das demais rotas — nunca adivinha um ID); `from`/`to` têm um default
   * de "próximos 7 dias a partir de agora" quando ausentes, porque esta é
   * uma consulta pura de leitura, sem efeito colateral — diferente de
   * `appointmentId`/`therapistId`, uma janela de tempo aproximada não
   * corre o risco de mutar o dado errado.
   */
  private async routeConsultarDisponibilidade(intent: IntentResult): Promise<IntentActionResult> {
    const { therapistId, from, to } = intent.entities as { therapistId?: string; from?: string; to?: string };
    if (!therapistId) return { actionTaken: false };

    const fromDate = from ? new Date(from) : new Date();
    const toDate = to ? new Date(to) : new Date(fromDate.getTime() + 7 * 24 * 60 * 60 * 1000);

    const slots = await this.consultarDisponibilidade.execute(therapistId, fromDate, toDate);
    if (slots.length === 0) {
      return { actionTaken: true, actionSummary: 'Nenhum horário disponível no período consultado.' };
    }

    const preview = slots
      .slice(0, 3)
      .map((s) => s.startsAt.toLocaleString('pt-BR'))
      .join(', ');
    return { actionTaken: true, actionSummary: `Horários disponíveis: ${preview}${slots.length > 3 ? '...' : ''}.` };
  }
}
