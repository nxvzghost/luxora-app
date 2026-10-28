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
import { PedidoDeConsultaPeloWhatsAppUseCase, PreparedTurn, WhatsAppTurn } from '@use-cases/appointment/pedido-pelo-whatsapp.use-case';

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
  /**
   * A-11 (19/10/2026) — o número é de exatamente um paciente, mas ele está
   * inativo ou com alta. Mesmo tratamento do ambíguo: nenhum paciente vai
   * para a IA, nenhuma ação é executada, e a conversa vai para a clínica,
   * com outro motivo no aviso.
   */
  identityInactive?: boolean;
  conversationHistory: ConversationMessage[];
  message: string;
  /** AD-016 — correlaciona todo o turno (3 chamadas de IA possíveis) com o restante dos logs do job/requisição de origem. */
  correlationId?: string;
  /**
   * K11 — a mensagem do WhatsApp deste turno: a conversa, o WAMID e quando
   * chegou ao webhook. Sem eles (chamadas fora do WhatsApp) o pedido em duas
   * etapas não roda, e a IA não cancela nem remarca nada.
   */
  whatsApp?: { conversationId: string; messageId: string; receivedAt: Date };
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
 *
 * K11 (ADR-0069; D1 a D8) — cancelar e remarcar pelo WhatsApp passam por
 * PedidoDeConsultaPeloWhatsAppUseCase, em duas etapas: o pedido e a pergunta
 * de confirmação, depois a resposta em outra mensagem. Antes de
 * interpretIntent ele dá à IA as consultas futuras do paciente identificado
 * (sem identificadores) e a pergunta pendente; depois, se a mensagem for um
 * pedido ou uma resposta, o turno é dele: o texto enviado é o que ele monta
 * (sem generateResponse) e nada passa pelo IntentActionRouter. Só roda com a
 * identidade resolvida — senão, a regra do ADR-0063 vale como antes.
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
    private readonly pedidoPeloWhatsApp: PedidoDeConsultaPeloWhatsAppUseCase,
  ) {}

  async execute(input: ProcessarMensagemInput): Promise<ProcessarMensagemResult> {
    const turnStart = Date.now();
    const ambiguous = input.identityAmbiguous === true;
    const inactive = !ambiguous && input.identityInactive === true;
    // Com o número ambíguo, ou de paciente inativo ou com alta (A-11), nenhum
    // paciente é entregue ao provedor de IA.
    const handedToClinic = ambiguous || inactive;
    const knownPatientId = handedToClinic ? undefined : input.patientId;

    // K11 — o pedido pendente da conversa e o contexto da IA, antes de interpretar a mensagem.
    const turn: WhatsAppTurn | undefined = input.whatsApp
      ? { tenantId: input.tenantId, ...input.whatsApp, patientId: knownPatientId, identityResolved: !!knownPatientId }
      : undefined;
    const prepared: PreparedTurn = turn ? await this.pedidoPeloWhatsApp.prepare(turn) : { pending: null };

    const intent = await this.aiProvider.interpretIntent({
      tenantId: input.tenantId,
      patientId: knownPatientId,
      conversationHistory: input.conversationHistory,
      message: input.message,
      correlationId: input.correlationId,
      appointmentContext: prepared.context,
    });

    // Eixo de identidade (Contact) — independente do eixo de intenção
    // acima. `resolvedPatientId` começa igual ao paciente que o número
    // identifica e só muda se a pessoa concluir o próprio cadastro nesta
    // mesma mensagem (Cenário 1, ADR-0045).
    let resolvedPatientId = knownPatientId;
    let identityPending = handedToClinic;
    let handoffReason: HumanHandoffReason | undefined = ambiguous ? 'shared_number' : inactive ? 'inactive_patient' : undefined;
    let patientNotice: string | undefined = handedToClinic ? CLINIC_WILL_CONTINUE : undefined;
    let contactActionTaken = false;
    let contactActionSummary: string | undefined;
    let contactConfirmationPrompt: string | undefined;
    let contactCost = 0;

    // Com o número ambíguo, ou de paciente fora de atendimento, não há o que
    // classificar: a regra é uma só (e um cadastro novo pelo mesmo número
    // não pode nascer daqui).
    if (input.contactId && !handedToClinic) {
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

    // K11 — pedido de cancelamento ou remarcação, ou resposta à pergunta
    // pendente: o turno é do pedido em duas etapas, e o texto é o dele.
    const identityResolved = !identityPending && !!resolvedPatientId;
    if (turn && identityResolved && !handoffReason) {
      const k11 = await this.pedidoPeloWhatsApp.handle({ ...turn, patientId: resolvedPatientId, identityResolved }, intent, prepared);
      if (k11) {
        return this.finishTurn(input, intent, {
          responseMessage: k11.responseMessage,
          actionTaken: k11.actionTaken || contactActionTaken,
          requiresEscalation: intent.requiresEscalation,
          cost: (intent.usage?.costEstimate ?? 0) + contactCost,
          patientId: resolvedPatientId,
          turnStart,
        });
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

    return this.finishTurn(input, intent, {
      responseMessage: response.message,
      actionTaken: actionResult.actionTaken || contactActionTaken,
      requiresEscalation: intent.requiresEscalation || handoffReason !== undefined,
      escalationReason: intent.escalationReason ?? (handoffReason ? `identidade: ${handoffReason}` : undefined),
      cost: (intent.usage?.costEstimate ?? 0) + contactCost + response.usage.costEstimate,
      patientId: resolvedPatientId,
      turnStart,
    });
  }

  /** Auditoria (ator `ai_agent`), teto de custo e métricas do turno — iguais em todo caminho. */
  private async finishTurn(
    input: ProcessarMensagemInput,
    intent: { intent: string },
    turn: {
      responseMessage: string;
      actionTaken: boolean;
      requiresEscalation: boolean;
      escalationReason?: string;
      cost: number;
      patientId?: string;
      turnStart: number;
    },
  ): Promise<ProcessarMensagemResult> {
    this.checkCostCeiling(turn.cost, input.tenantId, input.correlationId);

    await this.auditService.recordAll(
      [
        new AiInteractionAuditEvent(
          turn.patientId ?? 'desconhecido',
          input.tenantId,
          intent.intent,
          turn.cost,
          turn.requiresEscalation,
          turn.actionTaken,
        ),
      ],
      'ai_agent',
    );

    // Fase 8.2 — observabilidade: custo e duração por CONVERSA (turno
    // completo, até 3 chamadas de IA já somadas em totalCost) — nunca
    // rotulado por tenantId/patientId (cardinalidade ilimitada).
    this.metrics.observe('conversation_turn_cost_brl', turn.cost);
    this.metrics.observe('conversation_turn_duration_ms', Date.now() - turn.turnStart);
    this.metrics.incrementCounter('conversation_turns_total', {
      requires_escalation: turn.requiresEscalation,
      action_taken: turn.actionTaken,
    });

    return {
      responseMessage: turn.responseMessage,
      requiresEscalation: turn.requiresEscalation,
      escalationReason: turn.escalationReason,
      actionTaken: turn.actionTaken,
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
