import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConversationMessage } from '@domain-services/ai/ai-provider';
import { ConversationRepository, CONVERSATION_REPOSITORY } from '@domain-services/communication/conversation.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { ProcessarMensagemUseCase } from '@use-cases/ai/processar-mensagem.use-case';
import { MessageQueueProducer } from '@infrastructure/messaging/message-queue.producer';
import { WhatsAppInboundJobData } from '@infrastructure/messaging/whatsapp-inbound-queue.producer';

/**
 * ProcessarMensagemWhatsAppUseCase — ADR-0053 (AD-007). Parte ASSÍNCRONA
 * (consumida pelo worker da fila `whatsapp-inbound`): reconstrói o
 * histórico real da Conversation, chama o pipeline de IA já existente
 * (ProcessarMensagemUseCase/IntentActionRouter, sem alteração), grava a
 * resposta como Message de saída, e despacha o ENVIO real reaproveitando
 * 100% a fila/Use Case de saída já existentes (MessageQueueProducer →
 * EnviarMensagemUseCase → WhatsAppMessageProvider) — nunca um mecanismo de
 * envio novo.
 */
@Injectable()
export class ProcessarMensagemWhatsAppUseCase {
  constructor(
    private readonly processarMensagem: ProcessarMensagemUseCase,
    @Inject(CONVERSATION_REPOSITORY) private readonly conversationRepo: ConversationRepository,
    private readonly auditService: AuditService,
    private readonly outboundQueue: MessageQueueProducer,
  ) {}

  async execute(input: WhatsAppInboundJobData): Promise<void> {
    const conversation = await this.conversationRepo.findById(input.conversationId);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${input.conversationId} não encontrada.`);
    }

    const history = await this.conversationRepo.findMessagesByConversationId(input.conversationId);
    // A própria mensagem de entrada deste job já foi persistida
    // sincronamente (ReceberMensagemWhatsAppUseCase) — exclui o último
    // turno do histórico passado a ProcessarMensagemUseCase, que já
    // recebe `input.message` separadamente e o anexa internamente.
    const conversationHistory: ConversationMessage[] = history.slice(0, -1).map((m) => ({
      role: m.direction === 'entrada' ? 'user' : 'assistant',
      content: m.content,
    }));

    const result = await this.processarMensagem.execute({
      tenantId: input.tenantId,
      patientId: input.patientId,
      conversationHistory,
      message: input.message,
    });

    conversation.addMessage({ id: randomUUID(), direction: 'saida', content: result.responseMessage });
    await this.conversationRepo.appendMessages(conversation.pullPendingMessages(), input.tenantId);
    await this.auditService.recordAll(conversation.pullDomainEvents(), 'system');

    await this.outboundQueue.enqueue({
      tenantId: input.tenantId,
      toPhoneNumber: conversation.phoneNumber,
      body: result.responseMessage,
      idempotencyKey: `conversation-reply-${input.externalId}`,
      correlationId: input.correlationId,
    });
  }
}
