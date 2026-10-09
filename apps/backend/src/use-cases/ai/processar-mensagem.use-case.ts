import { Injectable, Inject, Logger } from '@nestjs/common';
import { IAIProvider, AI_PROVIDER, ConversationMessage } from '@domain-services/ai/ai-provider';
import { AuditService } from '@domain-services/platform/audit.service';
import { DomainEvent } from '@domain/shared/domain-event';
import { IntentActionRouter, IntentActionResult } from './intent-action-router';
import { CLINIC_WILL_CONTINUE, ContactIntentActionRouter } from '@use-cases/contact/contact-intent-action-router';
import {
  HumanHandoffReason,
  SolicitarAtendimentoHumanoUseCase,
} from '@use-cases/contact/solicitar-atendimento-humano.use-case';
import { MetricsService } from '@shared/metrics.service';

const COST_CEILING_PER_CONVERSATION_BRL = 0.25; // RNF-021
const COST_ALERT_THRESHOLD = 0.7; // alerta em 70% do teto, não bloqueio

export interface ProcessarMensagemInput {
  tenantId: string;
  /**
   * O paciente que o número identifica — só quando identifica exatamente um
   * (ResolverIdentidadeDoContatoUseCase). Nunca um palpite.
   */
  patientId?: string;
  /**
   * ADR-0055 (AD-018), Fase 7 — quando presente, aciona
   * ContactIntentActionRouter (promoção/associação/desambiguação de
   * identidade). Ausente: nenhum roteamento de Contact é tentado, mesmo
   * comportamento de antes desta fase (retrocompatível).
   */
  contactId?: string;
  /**
   * ADR-0063 (AD-038) — o número corresponde a dois ou mais pacientes.
   * Ninguém é escolhido, nenhuma ação que dependa da identidade é executada,
   * nenhum dado de paciente entra na resposta e a conversa vai para a clínica.
   */
  identityAmbiguous?: boolean;
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
 * está presente. Os dois roteadores nunca se conhecem.
 *
 * ADR-0063 (AD-037 e AD-038) — a identidade vem ANTES da ação. Neste turno,
 * uma ação que dependa de quem é o paciente (marcar, cancelar, confirmar,
 * remarcar, consultar cobrança) só é executada quando:
 *   - o número identifica exatamente um paciente — ou a pessoa acabou de
 *     concluir o próprio cadastro, com nome completo e confirmação; e
 *   - o eixo de identidade não pediu confirmação nem entregou a conversa à
 *     clínica neste mesmo turno.
 * Antes, o pedido de confirmação e a ação aconteciam juntos, e o pedido de
 * encaminhar a um humano não era lido por ninguém.
 *
 * Quando a conversa vai para a clínica, a equipe recebe um aviso interno
 * (SolicitarAtendimentoHumanoUseCase) e a pessoa ouve uma frase neutra, sem
 * nenhum dado de paciente.
 *
 * Todo turno é auditado com actor_type=ai_agent (Módulo 10), incluindo
 * custo real (somado das até 3 chamadas de IA possíveis: interpretIntent +
 * ContactIntentClassifier + generateResponse) e se alguma ação foi de fato
 * executada — alertando (não bloqueando) acima de 70% do teto de
 * R$ 0,25/conversa (RNF-021).
 */
@Injectable()
export class ProcessarMensagemUseCase {
  private readonly logger = new Logger(ProcessarMensagemUseCase.name);

  constructor(
    @Inject(AI_PROVIDER) private readonly aiProvider: IAIProvider,
    private readonly auditService: AuditService,
    private readonly intentActionRouter: IntentActionRouter,
    private readonly contactIntentActionRouter: ContactIntentActionRouter,
    private readonly metrics: MetricsService,
    private readonly solicitarAtendimentoHumano: SolicitarAtendimentoHumanoUseCase,
  ) {}

  async execute(input: ProcessarMensagemInput): Promise<ProcessarMensagemResult> {
    const turnStart = Date.now();
    const ambiguous = input.identityAmbiguous === true;
    // Com o número ambíguo, nenhum paciente é entregue ao provedor de IA.
    const knownPatientId = ambiguous ? undefined : input.patientId;

    const intent = await this.aiProvider.interpretIntent({
      tenantId: input.tenantId,
      patientId: knownPatientId,
      conversationHistory: input.conversationHistory,
      message: input.message,
      correlationId: input.correlationId,
    });

    // Eixo de identidade (Contact) — independente do eixo de intenção
    // acima. `resolvedPatientId` começa igual ao paciente que o número
    // identifica e só muda se a pessoa concluir o próprio cadastro nesta
    // mesma mensagem (Cenário 1, ADR-0045).
    let resolvedPatientId = knownPatientId;
    let identityPending = ambiguous;
    let handoffReason: HumanHandoffReason | undefined = ambiguous ? 'shared_number' : undefined;
    let patientNotice: string | undefined = ambiguous ? CLINIC_WILL_CONTINUE : undefined;
    let contactActionTaken = false;
    let contactActionSummary: string | undefined;
    let contactConfirmationPrompt: string | undefined;
    let contactCost = 0;

    // Com o número ambíguo não há o que classificar: a regra é uma só.
    if (input.contactId && !ambiguous) {
      const contactResult = await this.contactIntentActionRouter.route({
        tenantId: input.tenantId,
        contactId: input.contactId,
        conversationHistory: input.conversationHistory,
        message: input.message,
        knownPatientId,
        correlationId: input.correlationId,
      });

      if (contactResult.patientId) {
        resolvedPatientId = contactResult.patientId;
      }
      contactActionTaken = contactResult.actionTaken;
      contactActionSummary = contactResult.actionSummary;
      contactConfirmationPrompt = contactResult.confirmationPrompt;
      contactCost = contactResult.usage?.costEstimate ?? 0;
      if (contactResult.requiresConfirmation || contactResult.escalateToHuman) {
        identityPending = true;
      }
      if (contactResult.escalateToHuman) {
        handoffReason = contactResult.handoffReason ?? 'human_review';
        patientNotice = contactResult.patientNotice ?? CLINIC_WILL_CONTINUE;
      }
    }

    // Roteamento real — só tenta agir quando a própria IA não pediu
    // escalonamento. O IntentActionRouter recusa, por conta própria, toda
    // ação que dependa de identidade quando ela não está resolvida.
    const actionResult: IntentActionResult = intent.requiresEscalation
      ? { actionTaken: false }
      : await this.intentActionRouter.route(intent, {
          tenantId: input.tenantId,
          patientId: resolvedPatientId,
          identityResolved: !identityPending && !!resolvedPatientId,
        });

    if (handoffReason && input.contactId) {
      await this.solicitarAtendimentoHumano.execute({
        tenantId: input.tenantId,
        contactId: input.contactId,
        reason: handoffReason,
      });
    }

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
    if (patientNotice) {
      // A conversa foi entregue à clínica: a IA recebe a frase pronta, a
      // mesma em todos os casos, sem dado de paciente nenhum.
      conversationForResponse.push({ role: 'assistant', content: `[Informe ao paciente: ${patientNotice}]` });
    }

    const response = await this.aiProvider.generateResponse({
      tenantId: input.tenantId,
      patientId: resolvedPatientId,
      conversationHistory: conversationForResponse,
      intent,
      correlationId: input.correlationId,
    });

    const totalCost = (intent.usage?.costEstimate ?? 0) + contactCost + response.usage.costEstimate;
    this.checkCostCeiling(totalCost, input.tenantId, input.correlationId);

    const finalActionTaken = actionResult.actionTaken || contactActionTaken;
    const requiresEscalation = intent.requiresEscalation || handoffReason !== undefined;

    await this.auditService.recordAll(
      [
        new AiInteractionAuditEvent(
          resolvedPatientId ?? 'desconhecido',
          input.tenantId,
          intent.intent,
          totalCost,
          requiresEscalation,
          finalActionTaken,
        ),
      ],
      'ai_agent',
    );

    // Fase 8.2 — observabilidade: custo e duração por CONVERSA (turno
    // completo, até 3 chamadas de IA já somadas em totalCost) — nunca
    // rotulado por tenantId/patientId (cardinalidade ilimitada).
    this.metrics.observe('conversation_turn_cost_brl', totalCost);
    this.metrics.observe('conversation_turn_duration_ms', Date.now() - turnStart);
    this.metrics.incrementCounter('conversation_turns_total', {
      requires_escalation: requiresEscalation,
      action_taken: finalActionTaken,
    });

    return {
      responseMessage: response.message,
      requiresEscalation,
      escalationReason: intent.escalationReason ?? (handoffReason ? `identidade: ${handoffReason}` : undefined),
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
