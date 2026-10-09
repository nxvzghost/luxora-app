import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConversationMessage, UsageMetrics } from '@domain-services/ai/ai-provider';
import {
  ContactIntentClassifier,
  ContactIntentClassificationResult,
  ContactIntentDecision,
  CONTACT_INTENT_CLASSIFIER,
} from '@domain-services/ai/contact-intent-classifier';
import { Contact, ContactPatientAssociation } from '@domain/contact/contact.entity';
import { isFullName, normalizePersonName } from '@domain/contact/person-name';
import { ConsultarContatoUseCase } from './consultar-contato.use-case';
import { IdentificarContatoUseCase } from './identificar-contato.use-case';
import { PromoverContatoUseCase, PossibleDuplicatePatientError } from './promover-contato.use-case';
import { HumanHandoffReason } from './solicitar-atendimento-humano.use-case';
import { MetricsService } from '@shared/metrics.service';

export interface ContactIntentRoutingInput {
  tenantId: string;
  contactId: string;
  conversationHistory: ConversationMessage[];
  message: string;
  /**
   * O paciente que este número já identifica, quando identifica exatamente
   * um (ResolverIdentidadeDoContatoUseCase). O Router NUNCA descobre ou
   * adivinha um patientId sozinho (ADR-0046: nunca resolver ambiguidade
   * automaticamente).
   */
  knownPatientId?: string;
  /** ADR-0016 — correlaciona esta chamada com o restante dos logs do job/requisição de origem. */
  correlationId?: string;
}

export interface ContactIntentRoutingResult {
  decision: ContactIntentDecision;
  actionTaken: boolean;
  patientId?: string;
  requiresConfirmation?: boolean;
  confirmationPrompt?: string;
  escalateToHuman?: boolean;
  /** ADR-0063 (AD-038) — por que a conversa vai para a clínica; vira o aviso interno à equipe. */
  handoffReason?: HumanHandoffReason;
  /** ADR-0063 — o que dizer a quem escreve quando a conversa vai para a clínica. Nunca traz dado de paciente. */
  patientNotice?: string;
  reasoning?: string;
  error?: string;
  /** Espelha IntentActionResult.actionSummary — texto pronto para injetar no contexto de generateResponse(). */
  actionSummary?: string;
  /** ADR-0055 (AD-018), Fase 7 — RNF-021: custo real da chamada ao classificador, para ProcessarMensagemUseCase somar ao teto. */
  usage?: UsageMetrics;
}

export const ASK_FULL_NAME = 'Antes de agendar, preciso do seu nome completo.';

export function askNameConfirmation(name: string): string {
  return `Confirme, por favor: seu nome completo é "${name}" e você deseja se cadastrar como paciente da clínica?`;
}

/**
 * O que a pessoa ouve quando a conversa vai para a clínica. É a mesma frase
 * em todos os casos, de propósito: ela não diz se existe um paciente com
 * aquele nome, se o número é de mais de uma pessoa, nem coisa alguma sobre
 * cadastro, consulta ou cobrança de quem quer que seja.
 */
export const CLINIC_WILL_CONTINUE =
  'Por segurança, a equipe da clínica vai continuar este atendimento e confirmar os dados com você. Nada foi alterado por aqui.';

/**
 * ContactIntentActionRouter — ADR-0055 (AD-018), Fase 6; regras de
 * identidade da ADR-0063 (AD-037 e AD-038).
 *
 * Traduz a classificação da IA (ContactIntentClassifier) em, no máximo, UMA
 * chamada a um Use Case de Contact. A IA só sinaliza; quem decide é este
 * roteador, com regras fixas:
 *
 * PROMOVER — cadastro de quem ainda não é paciente, em dois tempos e em
 * mensagens diferentes:
 *   1. a pessoa informa o nome completo → o nome é guardado e ela é
 *      perguntada, com todas as letras, se confirma o nome e o cadastro;
 *   2. ela confirma explicitamente → só então o paciente é criado.
 * Nome e confirmação nunca valem no mesmo turno: a confirmação só conta se
 * o nome já estava guardado antes desta mensagem. Um número que já
 * identifica um paciente nunca abre outro cadastro. O nome de perfil do
 * WhatsApp não entra em nenhum ponto.
 *
 * ASSOCIAR — a mensagem trata de um paciente que este número não identifica
 * sozinho (outra pessoa, ou a própria pessoa em um número novo). O roteador
 * nunca associa nem vincula: o caso vai para a clínica, e o vínculo de um
 * número novo só existe com a aprovação de um administrador, pelo painel
 * (VincularContatoAPacienteUseCase — que este roteador não conhece).
 *
 * DESAMBIGUAR pede confirmação; HUMANO entrega à clínica; IGNORAR não faz
 * nada. Qualquer falha vira HUMANO — nunca uma ação.
 *
 * Quem recebe o resultado (ProcessarMensagemUseCase) não executa nenhuma
 * ação clínica ou financeira no turno em que este roteador pede confirmação
 * ou entrega a conversa à clínica.
 */
@Injectable()
export class ContactIntentActionRouter {
  private readonly logger = new Logger(ContactIntentActionRouter.name);

  constructor(
    @Inject(CONTACT_INTENT_CLASSIFIER) private readonly classifier: ContactIntentClassifier,
    private readonly consultarContato: ConsultarContatoUseCase,
    private readonly promoverContato: PromoverContatoUseCase,
    private readonly identificarContato: IdentificarContatoUseCase,
    private readonly metrics: MetricsService,
  ) {}

  async route(input: ContactIntentRoutingInput): Promise<ContactIntentRoutingResult> {
    let result: ContactIntentRoutingResult;
    try {
      const { contact, associations } = await this.consultarContato.execute(input.contactId);

      const classification = await this.classifier.classify({
        tenantId: input.tenantId,
        conversationHistory: input.conversationHistory,
        message: input.message,
        contactState: contact.state,
        associationCount: associations.length,
        correlationId: input.correlationId,
      });

      const dispatched = await this.dispatch(input, contact, associations, classification);
      result = { ...dispatched, usage: classification.usage };
    } catch (err) {
      this.logger.warn(
        `[correlationId=${input.correlationId ?? 'desconhecido'}] Falha ao rotear Contact ${input.contactId}: ${(err as Error).message}`,
      );
      result = {
        decision: 'HUMANO',
        actionTaken: false,
        escalateToHuman: true,
        handoffReason: 'human_review',
        patientNotice: CLINIC_WILL_CONTINUE,
        error: (err as Error).message,
      };
    }

    // Fase 8.2 — observabilidade: promoções/associações/desambiguações/
    // encaminhamentos para HUMANO, todos derivados de UM contador rotulado
    // (decision, action_taken) — nunca por contactId/tenantId (cardinalidade
    // ilimitada).
    this.metrics.incrementCounter('contact_router_decisions_total', {
      decision: result.decision,
      action_taken: result.actionTaken,
    });

    return result;
  }

  private async dispatch(
    input: ContactIntentRoutingInput,
    contact: Contact,
    associations: ContactPatientAssociation[],
    classification: ContactIntentClassificationResult,
  ): Promise<Omit<ContactIntentRoutingResult, 'usage'>> {
    switch (classification.decision) {
      case 'PROMOVER':
        return this.handlePromover(input, contact, associations, classification);
      case 'ASSOCIAR':
        return this.handleAssociar(input, classification);
      case 'DESAMBIGUAR':
        return {
          decision: 'DESAMBIGUAR',
          actionTaken: false,
          requiresConfirmation: true,
          confirmationPrompt: 'Não ficou claro para qual paciente é esta mensagem — pode confirmar o nome?',
          reasoning: classification.reasoning,
        };
      case 'HUMANO':
        return {
          decision: 'HUMANO',
          actionTaken: false,
          escalateToHuman: true,
          handoffReason: 'human_review',
          patientNotice: CLINIC_WILL_CONTINUE,
          reasoning: classification.reasoning,
        };
      case 'IGNORAR':
      default:
        return { decision: 'IGNORAR', actionTaken: false, reasoning: classification.reasoning };
    }
  }

  /**
   * Cenários 1 a 3 (ADR-0045), com a regra da ADR-0063: nome completo E
   * confirmação explícita antes de criar o cadastro.
   */
  private async handlePromover(
    input: ContactIntentRoutingInput,
    contact: Contact,
    associations: ContactPatientAssociation[],
    classification: ContactIntentClassificationResult,
  ): Promise<ContactIntentRoutingResult> {
    if (input.knownPatientId || associations.length > 0) {
      return {
        decision: 'PROMOVER',
        actionTaken: false,
        reasoning: 'Este número já identifica um paciente — nenhum cadastro novo é aberto.',
      };
    }

    const informedName = classification.patientNameHint?.trim();
    const informedFullName = informedName && isFullName(informedName) ? informedName : undefined;

    if (contact.state === 'Identificado' && contact.name) {
      // A pessoa corrigiu o nome antes de confirmar: vale o novo, e a
      // confirmação é pedida de novo — nunca aproveitada do mesmo turno.
      if (informedFullName && normalizePersonName(informedFullName) !== normalizePersonName(contact.name)) {
        await this.identificarContato.execute({ contactId: contact.id, name: informedFullName });
        return this.askForConfirmation(informedFullName, classification);
      }
      if (classification.explicitConfirmation !== true) {
        return this.askForConfirmation(contact.name, classification);
      }
      return this.promote(contact, classification);
    }

    if (!informedFullName) {
      return {
        decision: 'PROMOVER',
        actionTaken: false,
        requiresConfirmation: true,
        confirmationPrompt: ASK_FULL_NAME,
        reasoning: 'Contact ainda sem nome completo — não é possível cadastrar.',
      };
    }

    // Primeiro tempo: guarda o nome e pede a confirmação. Um "confirmo" que
    // venha junto, neste mesmo turno, não conta.
    await this.identificarContato.execute({ contactId: contact.id, name: informedFullName });
    return this.askForConfirmation(informedFullName, classification);
  }

  private askForConfirmation(name: string, classification: ContactIntentClassificationResult): ContactIntentRoutingResult {
    return {
      decision: 'PROMOVER',
      actionTaken: false,
      requiresConfirmation: true,
      confirmationPrompt: askNameConfirmation(name),
      reasoning: classification.reasoning,
    };
  }

  private async promote(contact: Contact, classification: ContactIntentClassificationResult): Promise<ContactIntentRoutingResult> {
    try {
      const { patient } = await this.promoverContato.execute({ contactId: contact.id, patientName: contact.name as string });
      return {
        decision: 'PROMOVER',
        actionTaken: true,
        patientId: patient.id,
        actionSummary: `Cadastro de ${patient.name} realizado com sucesso.`,
        reasoning: classification.reasoning,
      };
    } catch (err) {
      if (err instanceof PossibleDuplicatePatientError) {
        // Pode ser um paciente da clínica em um número novo. Nenhum
        // cadastro é aberto e nada é dito sobre a existência do outro.
        return {
          decision: 'PROMOVER',
          actionTaken: false,
          escalateToHuman: true,
          handoffReason: 'possible_duplicate',
          patientNotice: CLINIC_WILL_CONTINUE,
          reasoning: 'Já existe paciente com este nome na clínica — cadastro entregue à equipe.',
        };
      }
      throw err;
    }
  }

  /**
   * Cenários 11, 12 e 13 — a mensagem trata de um paciente que este número
   * não identifica sozinho. Nada é associado nem vinculado aqui: o caso vai
   * para a clínica. Quando o número ainda não identifica ninguém, é um
   * pedido de vínculo de número novo, que só um administrador aprova.
   */
  private handleAssociar(
    input: ContactIntentRoutingInput,
    classification: ContactIntentClassificationResult,
  ): ContactIntentRoutingResult {
    return {
      decision: 'ASSOCIAR',
      actionTaken: false,
      escalateToHuman: true,
      handoffReason: input.knownPatientId ? 'human_review' : 'link_request',
      patientNotice: CLINIC_WILL_CONTINUE,
      reasoning: classification.reasoning,
    };
  }
}
