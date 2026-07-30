import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConversationMessage } from '@domain-services/ai/ai-provider';
import { ConversationRepository, CONVERSATION_REPOSITORY } from '@domain-services/communication/conversation.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { ProcessarMensagemUseCase } from '@use-cases/ai/processar-mensagem.use-case';
import { WhatsAppInboundJobData } from '@infrastructure/messaging/whatsapp-inbound-queue.producer';

export interface ProcessarMensagemWhatsAppResult {
  responseMessage: string;
  toPhoneNumber: string;
}

/**
 * ProcessarMensagemWhatsAppUseCase — ADR-0053 (AD-007), escopo revisado
 * por ADR-0054 (AD-036). Fase 1 (a parte cara e não-idempotente) do
 * processamento assíncrono: reconstrói o histórico real da Conversation,
 * chama o pipeline de IA já existente (ProcessarMensagemUseCase/
 * IntentActionRouter, sem alteração), grava a resposta como Message de
 * saída, audita.
 *
 * NÃO despacha mais o envio — isso saiu daqui por decisão da ADR-0054: o
 * despacho (Fase 2) precisa poder ser tentado de novo, isoladamente, sem
 * jamais reexecutar esta Fase 1 (que já chamou a IA e o
 * IntentActionRouter). Essa separação só é possível se as duas fases
 * forem passos distintos e observáveis de fora — por isso o despacho
 * passou para WhatsAppInboundQueueWorker, que só o chama depois que o
 * checkpoint desta Fase 1 (InboxRepository.markGenerated()) já foi
 * gravado com sucesso. Retorna o necessário para esse despacho
 * acontecer, sem este Use Case precisar saber nada sobre filas/retry.
 */
@Injectable()
export class ProcessarMensagemWhatsAppUseCase {
  constructor(
    private readonly processarMensagem: ProcessarMensagemUseCase,
    @Inject(CONVERSATION_REPOSITORY) private readonly conversationRepo: ConversationRepository,
    private readonly auditService: AuditService,
  ) {}

  async execute(input: WhatsAppInboundJobData): Promise<ProcessarMensagemWhatsAppResult> {
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

    return { responseMessage: result.responseMessage, toPhoneNumber: conversation.phoneNumber };
  }
}
