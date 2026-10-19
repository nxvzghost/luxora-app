import { Injectable, Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { TenantContext } from '@shared/tenant-context';
import { CorrelationContext } from '@shared/correlation-context';
import { Conversation } from '@domain/communication/conversation.entity';
import { ConversationRepository, CONVERSATION_REPOSITORY } from '@domain-services/communication/conversation.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { WhatsAppInboundQueueProducer } from '@infrastructure/messaging/whatsapp-inbound-queue.producer';
import { MessageQueueProducer } from '@infrastructure/messaging/message-queue.producer';
import { ReconhecerOuCriarContatoUseCase } from '@use-cases/contact/reconhecer-ou-criar-contato.use-case';
import { ResolverIdentidadeDoContatoUseCase } from '@use-cases/contact/resolver-identidade-do-contato.use-case';
import { SolicitarAtendimentoHumanoUseCase } from '@use-cases/contact/solicitar-atendimento-humano.use-case';
import { AvisarFalhaDeEnvioUseCase } from '@use-cases/communication/avisar-falha-de-envio.use-case';
import { PhoneNumber } from '@domain/contact/phone-number.value-object';
import { logReference } from '@shared/logging/log-reference';

export interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: Array<{ id: string; from: string; type: string; text?: { body: string } }>;
        statuses?: Array<{ id: string; status: string; errors?: Array<{ code?: number }> }>;
      };
    }>;
  }>;
}

/**
 * A-15 da auditoria (19/10/2026) — o que a Meta entrega e não é conversa de
 * ninguém: reação (emoji sobre uma mensagem) e aviso de sistema (troca de
 * número etc.). Continuam ignorados, sem resposta nem aviso.
 */
const IGNORED_MESSAGE_TYPES = new Set(['reaction', 'system']);

/** Como cada tipo aparece no histórico da conversa. O que não está aqui vira "mensagem que não é texto". */
const MEDIA_LABELS: Record<string, string> = {
  audio: 'áudio',
  image: 'imagem',
  sticker: 'figurinha',
  video: 'vídeo',
  document: 'documento',
  location: 'localização',
  contacts: 'contato',
};

/**
 * Resposta fixa, sem IA e sem dado de paciente, a quem manda áudio, imagem,
 * figurinha etc. (A-15). Exportada para os testes conferirem o texto exato.
 */
export const UNSUPPORTED_MEDIA_REPLY =
  'Recebemos sua mensagem, mas por aqui só conseguimos ler texto. Pode escrever o que precisa? A equipe da clínica também foi avisada.';

/** Vários áudios seguidos recebem uma resposta só: ela não se repete na mesma conversa dentro deste intervalo. */
export const UNSUPPORTED_MEDIA_REPLY_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * ReceberMensagemWhatsAppUseCase — ADR-0053 (AD-007). Parte SÍNCRONA do
 * webhook: valida o mínimo, persiste a mensagem de entrada de forma
 * durável e idempotente, e despacha o processamento de IA para a fila —
 * nunca espera a IA responder antes de devolver 200 à Meta (§4).
 *
 * Um único POST pode conter mensagens de Tenants DIFERENTES (vários
 * phoneNumberId no mesmo payload) — TenantContext é resolvido e
 * re-inicializado a cada `change`, nunca uma vez só para a requisição
 * inteira (diferente do padrão de TenantApiKeyGuard/ProcessarWebhook-
 * AssinaturaUseCase, que sempre lidam com exatamente 1 Tenant por chamada).
 *
 * A-15 (19/10/2026) — áudio, imagem, figurinha e o resto que não é texto
 * eram pulados sem deixar rastro: quem mandava áudio ficava sem resposta e
 * a clínica nunca sabia. Agora a mensagem fica registrada na conversa, a
 * clínica recebe um aviso no painel (o mesmo recurso da escalada para
 * humano) e a pessoa recebe uma resposta fixa pedindo que escreva — sem
 * chamar a IA, que não lê esses formatos.
 */
@Injectable()
export class ReceberMensagemWhatsAppUseCase {
  private readonly logger = new Logger(ReceberMensagemWhatsAppUseCase.name);

  constructor(
    private readonly prismaClient: PrismaClientProvider,
    private readonly tenantContext: TenantContext,
    @Inject(CONVERSATION_REPOSITORY) private readonly conversationRepo: ConversationRepository,
    private readonly auditService: AuditService,
    private readonly inboundQueue: WhatsAppInboundQueueProducer,
    private readonly reconhecerOuCriarContatoUseCase: ReconhecerOuCriarContatoUseCase,
    private readonly correlationContext: CorrelationContext,
    private readonly resolverIdentidade: ResolverIdentidadeDoContatoUseCase,
    private readonly outboundQueue: MessageQueueProducer,
    private readonly solicitarAtendimentoHumano: SolicitarAtendimentoHumanoUseCase,
    private readonly avisarFalhaDeEnvio: AvisarFalhaDeEnvioUseCase,
  ) {}

  async execute(payload: WhatsAppWebhookPayload): Promise<void> {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const phoneNumberId = change.value?.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        const tenantId = await this.resolveTenantId(phoneNumberId);
        if (!tenantId) continue; // número não pertence a nenhum Tenant conectado — ignora silenciosamente

        this.tenantContext.set(tenantId, null);

        for (const message of change.value?.messages ?? []) {
          if (IGNORED_MESSAGE_TYPES.has(message.type)) continue;
          const isText = message.type === 'text';
          if (isText && !message.text?.body) continue;
          // Fase 3B da auditoria — ACHADO REAL: um remetente que não é um
          // telefone do Brasil fazia a normalização do Contact lançar, o
          // webhook respondia 500 e a Meta reenviava o mesmo POST por dias —
          // junto com as mensagens das outras pessoas que vinham nele. O
          // produto hoje atende só números do Brasil: a mensagem é
          // confirmada e ignorada, sem interromper as demais. A Meta sempre
          // envia o número com o código do país, por isso a leitura aqui é a
          // estrita (tryFromInternational), que não confunde um número de
          // outro país com "DDD + número".
          if (!PhoneNumber.tryFromInternational(message.from)) {
            this.logger.warn(
              `Mensagem ${logReference(message.id)} ignorada: o remetente não é um telefone do Brasil, único formato atendido hoje.`,
            );
            continue;
          }
          if (isText && message.text) {
            await this.processInboundMessage(tenantId, message.id, message.from, message.text.body);
          } else {
            await this.processUnsupportedMessage(tenantId, message.id, message.from, message.type);
          }
        }
        // A-08 (19/10/2026) — status `failed`: a Meta aceitou a mensagem,
        // mas ela não chegou (o caso típico é a janela de 24 horas). Vira
        // aviso no painel e o registro do envio passa a 'failed'. Entregue e
        // lida continuam sem uso.
        for (const status of change.value?.statuses ?? []) {
          if (status.status !== 'failed') continue;
          await this.avisarFalhaDeEnvio.naoEntregue({
            tenantId,
            providerMessageId: status.id,
            errorCode: status.errors?.[0]?.code,
          });
        }
      }
    }
  }

  /**
   * PD-007 (ADR-0053 §2.3) — índice único em phoneNumberId, lookup O(1).
   *
   * ACHADO REAL, corrigido durante a validação: a primeira versão usava
   * PrismaService.forAuthLookup() (bypass de RLS), mas whatsapp_integration
   * nunca teve RLS habilitada de fato — e não pode ter, sem quebrar
   * WhatsAppMessageProvider.send() (consulta a mesma tabela, deliberadamente
   * fora de TenantContext, filtro explícito por tenantId no WHERE — ver
   * migration 20260728173344). Corrigido para usar PrismaClientProvider
   * diretamente, exatamente o mesmo padrão já estabelecido por
   * WhatsAppMessageProvider para esta tabela — nenhum mecanismo de acesso
   * novo, só o já existente reaproveitado.
   */
  private async resolveTenantId(phoneNumberId: string): Promise<string | null> {
    const integration = await this.prismaClient.whatsAppIntegration.findUnique({ where: { phoneNumberId } });
    return integration?.active ? integration.tenantId : null;
  }

  private async processInboundMessage(
    tenantId: string,
    externalId: string,
    fromPhoneNumber: string,
    body: string,
  ): Promise<void> {
    const alreadyProcessed = await this.conversationRepo.findMessageByExternalId(externalId);
    if (alreadyProcessed) return; // idempotência (§5) — reentrega da Meta, no-op

    // ADR-0055 (AD-018), Fase 5 — único ponto de entrada para reconhecimento/
    // criação de Contact (identidade de comunicação, ver docs/01-Domain/08).
    // Aggregate independente de Conversation (Bounded Contexts distintos
    // dentro do mesmo domínio). Garante que todo Contact real exista e
    // reflita a interação, a cada mensagem de entrada; é a partir dele que a
    // identidade de quem escreve é resolvida, logo abaixo.
    const contact = await this.reconhecerOuCriarContatoUseCase.execute(tenantId, fromPhoneNumber);

    // ADR-0063 (AD-038) — a conversa só é ligada a um paciente quando o
    // número identifica exatamente um. Antes, com dois pacientes no mesmo
    // telefone, ela nascia ligada ao cadastro mais antigo. Quem decide em
    // nome de quem agir, a cada mensagem, é o processamento assíncrono, pela
    // mesma regra (ResolverIdentidadeDoContatoUseCase).
    const identity = await this.resolverIdentidade.execute(contact);
    const recognizedPatientId = identity.status === 'recognized' ? identity.patientId : null;

    let conversation = await this.conversationRepo.findByTenantAndPhone(tenantId, fromPhoneNumber);
    const isNewConversation = !conversation;
    if (!conversation) {
      conversation = Conversation.create({
        id: randomUUID(),
        tenantId,
        phoneNumber: fromPhoneNumber,
        patientId: recognizedPatientId,
      });
    }

    conversation.addMessage({ id: randomUUID(), direction: 'entrada', content: body, externalId });

    if (isNewConversation) {
      await this.conversationRepo.save(conversation);
    }
    await this.conversationRepo.appendMessages(conversation.pullPendingMessages(), tenantId);

    // Ator não-autenticado (mensagem chegou via webhook, sem JWT) — mesmo
    // padrão já usado por ProcessarWebhookAssinaturaUseCase.
    await this.auditService.recordAll(conversation.pullDomainEvents(), 'system');

    await this.inboundQueue.enqueue({
      tenantId,
      conversationId: conversation.id,
      patientId: recognizedPatientId ?? undefined,
      message: body,
      externalId,
      // ADR-0055 (AD-018), Fase 8.2 — ACHADO REAL: este campo já existia em
      // WhatsAppInboundJobData desde a AD-016, mas nunca era de fato
      // preenchido aqui — WhatsAppInboundQueueWorker sempre caía no
      // fallback `?? randomUUID()`, gerando um id novo sem nenhuma relação
      // com a requisição HTTP original. Agora o correlationId nasce no
      // middleware (correlationIdMiddleware) e se propaga de ponta a
      // ponta: Webhook → Queue → Worker → ProcessarMensagemWhatsAppUseCase
      // → ProcessarMensagemUseCase → AnthropicAIProvider/
      // AnthropicContactIntentClassifier.
      correlationId: this.correlationContext.correlationId,
    });
  }

  /**
   * A-15 — mensagem que não é texto. Não passa pela IA: registra a mensagem
   * na conversa, avisa a clínica e responde com o texto fixo.
   *
   * Ordem pensada para a reentrega da Meta: o aviso e o envio vêm antes de
   * gravar a mensagem de entrada (que é a marca de "já processada"). Se a
   * gravação falhar, a Meta reenvia; o aviso não duplica enquanto não for
   * lido, e o envio usa a mesma chave de idempotência, que a fila e o
   * registro de envios recusam repetir.
   */
  private async processUnsupportedMessage(
    tenantId: string,
    externalId: string,
    fromPhoneNumber: string,
    type: string,
  ): Promise<void> {
    const alreadyProcessed = await this.conversationRepo.findMessageByExternalId(externalId);
    if (alreadyProcessed) return;

    const contact = await this.reconhecerOuCriarContatoUseCase.execute(tenantId, fromPhoneNumber);
    const identity = await this.resolverIdentidade.execute(contact);
    const recognizedPatientId = identity.status === 'recognized' ? identity.patientId : null;

    let conversation = await this.conversationRepo.findByTenantAndPhone(tenantId, fromPhoneNumber);
    const isNewConversation = !conversation;
    if (!conversation) {
      conversation = Conversation.create({
        id: randomUUID(),
        tenantId,
        phoneNumber: fromPhoneNumber,
        patientId: recognizedPatientId,
      });
    }

    const history = isNewConversation ? [] : await this.conversationRepo.findMessagesByConversationId(conversation.id);
    const now = Date.now();
    const repliedRecently = history.some(
      (m) =>
        m.direction === 'saida' &&
        m.content === UNSUPPORTED_MEDIA_REPLY &&
        now - m.createdAt.getTime() < UNSUPPORTED_MEDIA_REPLY_INTERVAL_MS,
    );

    await this.solicitarAtendimentoHumano.execute({ tenantId, contactId: contact.id, reason: 'unsupported_media' });

    const label = MEDIA_LABELS[type] ?? 'mensagem que não é texto';
    conversation.addMessage({
      id: randomUUID(),
      direction: 'entrada',
      content: `[${label} — não lido: o atendimento automático só lê texto]`,
      externalId,
    });

    if (!repliedRecently) {
      await this.outboundQueue.enqueue({
        tenantId,
        toPhoneNumber: fromPhoneNumber,
        body: UNSUPPORTED_MEDIA_REPLY,
        idempotencyKey: `unsupported-media-reply-${externalId}`,
        correlationId: this.correlationContext.correlationId,
      });
      conversation.addMessage({ id: randomUUID(), direction: 'saida', content: UNSUPPORTED_MEDIA_REPLY });
    }

    if (isNewConversation) {
      await this.conversationRepo.save(conversation);
    }
    await this.conversationRepo.appendMessages(conversation.pullPendingMessages(), tenantId);
    await this.auditService.recordAll(conversation.pullDomainEvents(), 'system');
  }
}
