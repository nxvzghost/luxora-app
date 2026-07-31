import { Injectable, Inject, Logger } from '@nestjs/common';
import { IAIProvider, AI_PROVIDER, ConversationMessage } from '@domain-services/ai/ai-provider';
import { AuditService } from '@domain-services/platform/audit.service';
import { DomainEvent } from '@domain/shared/domain-event';
import { IntentActionRouter } from './intent-action-router';
import { ContactIntentActionRouter } from '@use-cases/contact/contact-intent-action-router';

const COST_CEILING_PER_CONVERSATION_BRL = 0.25; // RNF-021
const COST_ALERT_THRESHOLD = 0.7; // alerta em 70% do teto, não bloqueio

export interface ProcessarMensagemInput {
  tenantId: string;
  patientId?: string;
  /**
   * ADR-0055 (AD-018), Fase 7 — quando presente, aciona
   * ContactIntentActionRouter (promoção/associação/desambiguação de
   * identidade). Ausente: nenhum roteamento de Contact é tentado, mesmo
   * comportamento de antes desta fase (retrocompatível).
   */
  contactId?: string;
  conversationHistory: ConversationMessage[];
  message: string;
  /** AD-016 — correlaciona todo o turno (3 chamadas de IA possíveis) com o restante dos logs do job/requisição de origem. */
  correlationId?: string;
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
 * ADR-0055 (AD-018), Fase 7 — acrescenta um SEGUNDO eixo de roteamento,
 * independente: ContactIntentActionRouter, chamado só quando `input.contactId`
 * está presente. Os dois roteadores nunca se conhecem — IntentActionRouter
 * continua resolvendo agendamento/cobrança exatamente como antes; a única
 * ponte é o `patientId` que ContactIntentActionRouter pode RESOLVER (ex.:
 * promover um Contact novo cria um Patient de verdade) e que passa a ser
 * usado no lugar de `input.patientId` para o roteamento de intent desta
 * MESMA mensagem — fecha o gap de "contato novo não consegue agendar",
 * identificado desde a concepção do ADR-0055.
 *
 * Todo turno é auditado com actor_type=ai_agent (Módulo 10), incluindo
 * custo real (agora somado das até 3 chamadas de IA possíveis:
 * interpretIntent + ContactIntentClassifier + generateResponse) e se
 * alguma ação foi de fato executada — alertando (não bloqueando) acima de
 * 70% do teto de R$ 0,25/conversa (RNF-021).
 */
@Injectable()
export class ProcessarMensagemUseCase {
  private readonly logger = new Logger(ProcessarMensagemUseCase.name);

  constructor(
    @Inject(AI_PROVIDER) private readonly aiProvider: IAIProvider,
    private readonly auditService: AuditService,
    private readonly intentActionRouter: IntentActionRouter,
    private readonly contactIntentActionRouter: ContactIntentActionRouter,
  ) {}

  async execute(input: ProcessarMensagemInput): Promise<ProcessarMensagemResult> {
    const intent = await this.aiProvider.interpretIntent({
      tenantId: input.tenantId,
      patientId: input.patientId,
      conversationHistory: input.conversationHistory,
      message: input.message,
    });

    // Eixo de identidade (Contact) — independente do eixo de intenção
    // acima. `resolvedPatientId` começa igual a input.patientId e só muda
    // se o roteamento de Contact resolver/criar um Patient nesta mesma
    // mensagem (Cenário 1, ADR-0045).
    let resolvedPatientId = input.patientId;
    let contactActionTaken = false;
    let contactActionSummary: string | undefined;
    let contactConfirmationPrompt: string | undefined;
    let contactCost = 0;

    if (input.contactId) {
      const contactResult = await this.contactIntentActionRouter.route({
        tenantId: input.tenantId,
        contactId: input.contactId,
        conversationHistory: input.conversationHistory,
        message: input.message,
        knownPatientId: input.patientId,
        correlationId: input.correlationId,
      });

      if (contactResult.patientId) {
        resolvedPatientId = contactResult.patientId;
      }
      contactActionTaken = contactResult.actionTaken;
      contactActionSummary = contactResult.actionSummary;
      contactConfirmationPrompt = contactResult.confirmationPrompt;
      contactCost = contactResult.usage?.costEstimate ?? 0;
    }

    // Roteamento real — só tenta agir quando a própria IA não pediu
    // escalonamento. Nunca executa ação em cima de um intent que a IA já
    // sinalizou como incerto ou sensível.
    const actionResult = intent.requiresEscalation
      ? { actionTaken: false }
      : await this.intentActionRouter.route(intent, { tenantId: input.tenantId, patientId: resolvedPatientId });

    const conversationForResponse = [...input.conversationHistory, { role: 'user' as const, content: input.message }];
    if (actionResult.actionTaken && actionResult.actionSummary) {
      // Injeta o resultado real da ação como contexto de sistema, para a
      // resposta em linguagem natural refletir o que de fato aconteceu.
      conversationForResponse.push({ role: 'assistant', content: `[Ação executada: ${actionResult.actionSummary}]` });
    }
    if (contactActionSummary) {
      conversationForResponse.push({ role: 'assistant', content: `[Ação executada: ${contactActionSummary}]` });
    }
    if (contactConfirmationPrompt) {
      // A decisão de PEDIR confirmação já foi tomada pelo backend
      // (ContactIntentActionRouter) — a IA só recebe a instrução pronta,
      // nunca decide sozinha se deve ou não desambiguar.
      conversationForResponse.push({ role: 'assistant', content: `[Pergunte ao paciente: ${contactConfirmationPrompt}]` });
    }

    const response = await this.aiProvider.generateResponse({
      tenantId: input.tenantId,
      patientId: resolvedPatientId,
      conversationHistory: conversationForResponse,
      intent,
    });

    const totalCost = (intent.usage?.costEstimate ?? 0) + contactCost + response.usage.costEstimate;
    this.checkCostCeiling(totalCost, input.tenantId, input.correlationId);

    const finalActionTaken = actionResult.actionTaken || contactActionTaken;

    await this.auditService.recordAll(
      [
        new AiInteractionAuditEvent(
          resolvedPatientId ?? 'desconhecido',
          input.tenantId,
          intent.intent,
          totalCost,
          intent.requiresEscalation,
          finalActionTaken,
        ),
      ],
      'ai_agent',
    );

    return {
      responseMessage: response.message,
      requiresEscalation: intent.requiresEscalation,
      escalationReason: intent.escalationReason,
      actionTaken: finalActionTaken,
    };
  }

  private checkCostCeiling(costEstimate: number, tenantId: string, correlationId?: string): void {
    if (costEstimate >= COST_CEILING_PER_CONVERSATION_BRL * COST_ALERT_THRESHOLD) {
      this.logger.warn(
        `[correlationId=${correlationId ?? 'desconhecido'}] Custo de IA em ${(costEstimate / COST_CEILING_PER_CONVERSATION_BRL) * 100}% do teto para Tenant ${tenantId}: R$ ${costEstimate.toFixed(4)}`,
      );
    }
  }
}
