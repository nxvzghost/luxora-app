import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConversationMessage } from '@domain-services/ai/ai-provider';
import { ConversationRepository, CONVERSATION_REPOSITORY } from '@domain-services/communication/conversation.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { ProcessarMensagemUseCase } from '@use-cases/ai/processar-mensagem.use-case';
import { ReconhecerOuCriarContatoUseCase } from '@use-cases/contact/reconhecer-ou-criar-contato.use-case';
import { WhatsAppInboundJobData } from '@infrastructure/messaging/whatsapp-inbound-queue.producer';
import { MetricsService } from '@shared/metrics.service';

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
 *
 * ADR-0055 (AD-018), Fase 7 — re-resolve o Contact via
 * ReconhecerOuCriarContatoUseCase, usando `conversation.phoneNumber`
 * (string simples, nunca uma referência de domínio — Conversation
 * continua independente de Contact). Idempotente por natureza
 * (interagir() é um no-op depois da primeira vez), então chamá-lo de novo
 * aqui — para o mesmo telefone já reconhecido sincronamente por
 * ReceberMensagemWhatsAppUseCase — nunca duplica nada; é a forma mais
 * simples de obter o contactId dentro do worker assíncrono sem tocar no
 * payload do BullMQ (Inbox Pattern/AD-036 permanece intocado).
 */
@Injectable()
export class ProcessarMensagemWhatsAppUseCase {
  constructor(
    private readonly processarMensagem: ProcessarMensagemUseCase,
    @Inject(CONVERSATION_REPOSITORY) private readonly conversationRepo: ConversationRepository,
    private readonly auditService: AuditService,
    private readonly reconhecerOuCriarContato: ReconhecerOuCriarContatoUseCase,
    private readonly metrics: MetricsService,
  ) {}

  async execute(input: WhatsAppInboundJobData): Promise<ProcessarMensagemWhatsAppResult> {
    const start = Date.now();
    try {
      const result = await this.executeInternal(input);
      this.metrics.observe('whatsapp_message_processing_duration_ms', Date.now() - start);
      this.metrics.incrementCounter('whatsapp_messages_processed_total', { outcome: 'success' });
      return result;
    } catch (err) {
      this.metrics.observe('whatsapp_message_processing_duration_ms', Date.now() - start);
      this.metrics.incrementCounter('whatsapp_messages_processed_total', { outcome: 'error' });
      throw err;
    }
  }

  private async executeInternal(input: WhatsAppInboundJobData): Promise<ProcessarMensagemWhatsAppResult> {
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

    const contact = await this.reconhecerOuCriarContato.execute(input.tenantId, conversation.phoneNumber);

    const result = await this.processarMensagem.execute({
      tenantId: input.tenantId,
      patientId: input.patientId,
      contactId: contact.id,
      conversationHistory,
      message: input.message,
      correlationId: input.correlationId,
    });

    conversation.addMessage({ id: randomUUID(), direction: 'saida', content: result.responseMessage });
    await this.conversationRepo.appendMessages(conversation.pullPendingMessages(), input.tenantId);
    await this.auditService.recordAll(conversation.pullDomainEvents(), 'system');

    return { responseMessage: result.responseMessage, toPhoneNumber: conversation.phoneNumber };
  }
}
