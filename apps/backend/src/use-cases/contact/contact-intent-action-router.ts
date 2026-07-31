import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConversationMessage, UsageMetrics } from '@domain-services/ai/ai-provider';
import {
  ContactIntentClassifier,
  ContactIntentClassificationResult,
  ContactIntentDecision,
  CONTACT_INTENT_CLASSIFIER,
} from '@domain-services/ai/contact-intent-classifier';
import { Contact, ContactPatientAssociation, DuplicateContactPatientAssociationError } from '@domain/contact/contact.entity';
import { ConsultarContatoUseCase } from './consultar-contato.use-case';
import { PromoverContatoUseCase } from './promover-contato.use-case';
import { AssociarContatoUseCase } from './associar-contato.use-case';

export interface ContactIntentRoutingInput {
  tenantId: string;
  contactId: string;
  conversationHistory: ConversationMessage[];
  message: string;
  /**
   * Já resolvido por fora (ex.: Conversation.patientId, obtido via
   * PatientRepository.findByPhone() em outro Use Case) — o Router NUNCA
   * descobre ou adivinha um patientId sozinho (ADR-0046: nunca resolver
   * ambiguidade automaticamente).
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
  reasoning?: string;
  error?: string;
  /** Espelha IntentActionResult.actionSummary — texto pronto para injetar no contexto de generateResponse(). */
  actionSummary?: string;
  /** ADR-0055 (AD-018), Fase 7 — RNF-021: custo real da chamada ao classificador, para ProcessarMensagemUseCase somar ao teto. */
  usage?: UsageMetrics;
}

/**
 * ContactIntentActionRouter — ADR-0055 (AD-018), Fase 6.
 *
 * Mesmo papel, para o vínculo de identidade do Contact, que
 * IntentActionRouter (use-cases/ai/) já tem para agendamento/cobrança —
 * um componente deliberadamente SEM lógica de domínio: só traduz uma
 * classificação já feita pela IA (ContactIntentClassifier) em UMA
 * chamada a um dos Use Cases de Contact, ou nenhuma. Depende só de Use
 * Cases (ConsultarContatoUseCase, PromoverContatoUseCase,
 * AssociarContatoUseCase) e do classificador — nunca de
 * ContactRepository, nunca do Prisma, nunca cria um Contact/Aggregate
 * manualmente.
 *
 * REGRA DE SEGURANÇA (mesmo espírito do IntentActionRouter existente):
 * toda validação de invariante (transição de estado, duplicidade de
 * associação, qualificação do Contact) já vive inteiramente no Aggregate
 * (Fase 2) — este Router nunca a duplica. Chama o Use Case e deixa
 * qualquer erro de domínio virar `{ actionTaken:false, error }`, o mesmo
 * texto que garante idempotência: chamar PROMOVER duas vezes para o
 * mesmo Contact nunca promove duas vezes — a segunda chamada esbarra na
 * StateMachine do Aggregate (via PromoverContatoUseCase) e retorna aqui
 * como falha segura, nunca como uma segunda mutação.
 *
 * ASSOCIAR só age quando `knownPatientId` já está resolvido — sem ele
 * (ou com múltiplas associações concorrentes e nenhum sinal claro), o
 * Router nunca adivinha: devolve `requiresConfirmation`, nunca chama
 * AssociarContatoUseCase com um palpite.
 */
@Injectable()
export class ContactIntentActionRouter {
  private readonly logger = new Logger(ContactIntentActionRouter.name);

  constructor(
    @Inject(CONTACT_INTENT_CLASSIFIER) private readonly classifier: ContactIntentClassifier,
    private readonly consultarContato: ConsultarContatoUseCase,
    private readonly promoverContato: PromoverContatoUseCase,
    private readonly associarContato: AssociarContatoUseCase,
  ) {}

  async route(input: ContactIntentRoutingInput): Promise<ContactIntentRoutingResult> {
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

      const result = await this.dispatch(input, contact, associations, classification);
      return { ...result, usage: classification.usage };
    } catch (err) {
      this.logger.warn(
        `[correlationId=${input.correlationId ?? 'desconhecido'}] Falha ao rotear Contact ${input.contactId}: ${(err as Error).message}`,
      );
      return { decision: 'HUMANO', actionTaken: false, escalateToHuman: true, error: (err as Error).message };
    }
  }

  private async dispatch(
    input: ContactIntentRoutingInput,
    contact: Contact,
    associations: ContactPatientAssociation[],
    classification: ContactIntentClassificationResult,
  ): Promise<Omit<ContactIntentRoutingResult, 'usage'>> {
    switch (classification.decision) {
      case 'PROMOVER':
        return this.handlePromover(contact, associations, classification);
      case 'ASSOCIAR':
        return this.handleAssociar(input, contact, associations, classification);
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
          reasoning: classification.reasoning,
        };
      case 'IGNORAR':
      default:
        return { decision: 'IGNORAR', actionTaken: false, reasoning: classification.reasoning };
    }
  }

  /**
   * Cenário 1/3 (ADR-0045) — só age quando o Contact ainda não tem
   * nenhuma associação e já tem nome capturado (identificar(), Fase 2).
   * Sem nome: não há como cadastrar o Patient — devolve `actionTaken:false`
   * em vez de adivinhar um nome. Já associado: idempotente — nunca
   * promove duas vezes (ver nota da classe).
   */
  private async handlePromover(
    contact: Contact,
    associations: ContactPatientAssociation[],
    classification: ContactIntentClassificationResult,
  ): Promise<ContactIntentRoutingResult> {
    if (associations.length > 0) {
      return {
        decision: 'PROMOVER',
        actionTaken: false,
        reasoning: 'Contact já possui associação com um Paciente — promoção não repetida (idempotente).',
      };
    }
    if (!contact.name) {
      return {
        decision: 'PROMOVER',
        actionTaken: false,
        requiresConfirmation: true,
        confirmationPrompt: 'Antes de agendar, preciso do seu nome completo.',
        reasoning: 'Contact ainda não identificado (sem nome) — não é possível promover.',
      };
    }

    const { patient } = await this.promoverContato.execute({ contactId: contact.id, patientName: contact.name });
    return {
      decision: 'PROMOVER',
      actionTaken: true,
      patientId: patient.id,
      actionSummary: `Cadastro de ${patient.name} realizado com sucesso.`,
      reasoning: classification.reasoning,
    };
  }

  /**
   * Cenário 11 tardio / 12 — associação adicional. Só age com
   * `knownPatientId` já resolvido por fora (nunca descoberto aqui).
   *
   * Idempotência (Contact já associado a este mesmo Patient) NUNCA é
   * checada aqui de antemão — isso duplicaria a regra que
   * `Contact.associarAPaciente()` já garante (DuplicateContactPatientAssociationError).
   * Em vez disso, sempre tenta o Use Case e trata especificamente esse
   * erro como sucesso idempotente — única fonte de verdade sobre "já
   * associado" continua sendo o Aggregate.
   */
  private async handleAssociar(
    input: ContactIntentRoutingInput,
    contact: Contact,
    associations: ContactPatientAssociation[],
    classification: ContactIntentClassificationResult,
  ): Promise<ContactIntentRoutingResult> {
    if (!input.knownPatientId) {
      return {
        decision: 'ASSOCIAR',
        actionTaken: false,
        requiresConfirmation: true,
        confirmationPrompt: classification.patientNameHint
          ? `Você mencionou "${classification.patientNameHint}" — pode confirmar o nome completo desse paciente?`
          : 'Para qual paciente é esta consulta? Pode confirmar o nome completo?',
        reasoning: classification.reasoning,
      };
    }

    try {
      const { association } = await this.associarContato.execute({
        contactId: contact.id,
        patientId: input.knownPatientId,
      });
      return {
        decision: 'ASSOCIAR',
        actionTaken: true,
        patientId: association.patientId,
        actionSummary: 'Paciente adicional vinculado ao seu contato.',
        reasoning: classification.reasoning,
      };
    } catch (err) {
      if (err instanceof DuplicateContactPatientAssociationError) {
        return {
          decision: 'ASSOCIAR',
          actionTaken: false,
          patientId: input.knownPatientId,
          reasoning: 'Contact já associado a este Paciente — associação não repetida (idempotente).',
        };
      }
      throw err;
    }
  }
}
