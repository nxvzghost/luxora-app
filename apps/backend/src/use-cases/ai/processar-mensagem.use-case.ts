import { Injectable, Inject, Logger } from '@nestjs/common';
import { IAIProvider, AI_PROVIDER, ConversationMessage } from '@domain-services/ai/ai-provider';
import { AuditService } from '@domain-services/platform/audit.service';
import { DomainEvent } from '@domain/shared/domain-event';
import { IntentActionRouter } from './intent-action-router';

const COST_CEILING_PER_CONVERSATION_BRL = 0.25; // RNF-021
const COST_ALERT_THRESHOLD = 0.7; // alerta em 70% do teto, não bloqueio

export interface ProcessarMensagemInput {
  tenantId: string;
  patientId?: string;
  conversationHistory: ConversationMessage[];
  message: string;
}

export interface ProcessarMensagemResult {
  responseMessage: string;
  requiresEscalation: boolean;
  escalationReason?: string;
  actionTaken: boolean;
}

class AiInteractionAuditEvent extends DomainEvent {
  declare readonly intent: string;
  declare readonly costEstimate: number;
  declare readonly requiresEscalation: boolean;
  declare readonly actionTaken: boolean;

  constructor(
    entityId: string,
    tenantId: string,
    intent: string,
    costEstimate: number,
    requiresEscalation: boolean,
    actionTaken: boolean,
  ) {
    super('InteracaoDeIA', entityId, tenantId, { intent, costEstimate, requiresEscalation, actionTaken });
  }
}

/**
 * ProcessarMensagemUseCase — Módulo 12. Ponto de entrada real do agente.
 *
 * FECHA O GAP DO ADR-0033: agora chama IntentActionRouter quando o intent
 * não exige escalonamento — o agente não só conversa, ele age. Uma ação
 * bem-sucedida entra no contexto passado para generateResponse(), para
 * que a resposta ao paciente reflita o que de fato aconteceu (ex:
 * "consulta confirmada!"), nunca uma resposta genérica desconectada da
 * ação real.
 *
 * Todo turno é auditado com actor_type=ai_agent (Módulo 10), incluindo
 * custo real e se uma ação foi de fato executada — alertando (não
 * bloqueando) acima de 70% do teto de R$ 0,25/conversa (RNF-021).
 */
@Injectable()
export class ProcessarMensagemUseCase {
  private readonly logger = new Logger(ProcessarMensagemUseCase.name);

  constructor(
    @Inject(AI_PROVIDER) private readonly aiProvider: IAIProvider,
    private readonly auditService: AuditService,
    private readonly intentActionRouter: IntentActionRouter,
  ) {}

  async execute(input: ProcessarMensagemInput): Promise<ProcessarMensagemResult> {
    const intent = await this.aiProvider.interpretIntent({
      tenantId: input.tenantId,
      patientId: input.patientId,
      conversationHistory: input.conversationHistory,
      message: input.message,
    });

    // Roteamento real — só tenta agir quando a própria IA não pediu
    // escalonamento. Nunca executa ação em cima de um intent que a IA já
    // sinalizou como incerto ou sensível.
    const actionResult = intent.requiresEscalation
      ? { actionTaken: false }
      : await this.intentActionRouter.route(intent, { tenantId: input.tenantId, patientId: input.patientId });

    const conversationForResponse = [...input.conversationHistory, { role: 'user' as const, content: input.message }];
    if (actionResult.actionTaken && actionResult.actionSummary) {
      // Injeta o resultado real da ação como contexto de sistema, para a
      // resposta em linguagem natural refletir o que de fato aconteceu.
      conversationForResponse.push({ role: 'assistant', content: `[Ação executada: ${actionResult.actionSummary}]` });
    }

    const response = await this.aiProvider.generateResponse({
      tenantId: input.tenantId,
      patientId: input.patientId,
      conversationHistory: conversationForResponse,
      intent,
    });

    this.checkCostCeiling(response.usage.costEstimate, input.tenantId);

    await this.auditService.recordAll(
      [
        new AiInteractionAuditEvent(
          input.patientId ?? 'desconhecido',
          input.tenantId,
          intent.intent,
          response.usage.costEstimate,
          intent.requiresEscalation,
          actionResult.actionTaken,
        ),
      ],
      'ai_agent',
    );

    return {
      responseMessage: response.message,
      requiresEscalation: intent.requiresEscalation,
      escalationReason: intent.escalationReason,
      actionTaken: actionResult.actionTaken,
    };
  }

  private checkCostCeiling(costEstimate: number, tenantId: string): void {
    if (costEstimate >= COST_CEILING_PER_CONVERSATION_BRL * COST_ALERT_THRESHOLD) {
      this.logger.warn(
        `Custo de IA em ${(costEstimate / COST_CEILING_PER_CONVERSATION_BRL) * 100}% do teto para Tenant ${tenantId}: R$ ${costEstimate.toFixed(4)}`,
      );
    }
  }
}
