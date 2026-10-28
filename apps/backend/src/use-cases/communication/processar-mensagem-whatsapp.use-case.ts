import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConversationRepository, CONVERSATION_REPOSITORY } from '@domain-services/communication/conversation.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { ProcessarMensagemUseCase } from '@use-cases/ai/processar-mensagem.use-case';
import { ReconhecerOuCriarContatoUseCase } from '@use-cases/contact/reconhecer-ou-criar-contato.use-case';
import { ResolverIdentidadeDoContatoUseCase } from '@use-cases/contact/resolver-identidade-do-contato.use-case';
import { WhatsAppInboundJobData } from '@infrastructure/messaging/whatsapp-inbound-queue.producer';
import { MetricsService } from '@shared/metrics.service';
import { aiHistoryWindow, toAiHistory } from '@use-cases/communication/ai-history-window';

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
    private readonly resolverIdentidade: ResolverIdentidadeDoContatoUseCase,
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

    // D-A do A-14 — só o trecho recente da conversa vai para a IA (até 20
    // mensagens, contando a atual, das últimas 72 horas; ai-history-window.ts).
    // A mensagem deste job já foi gravada (ReceberMensagemWhatsAppUseCase) e
    // fica de fora da busca: ProcessarMensagemUseCase a recebe em
    // `input.message` e a anexa uma única vez, no fim.
    const window = aiHistoryWindow(new Date());
    const previous = await this.conversationRepo.findRecentMessagesBefore({
      conversationId: input.conversationId,
      currentExternalId: input.externalId,
      since: window.since,
      limit: window.previousLimit,
    });
    const conversationHistory = toAiHistory(previous);

    const contact = await this.reconhecerOuCriarContato.execute(input.tenantId, conversation.phoneNumber);

    // ADR-0063 (AD-037 e AD-038) — a quem o número pertence é resolvido
    // AGORA, a cada mensagem, pela regra única de
    // ResolverIdentidadeDoContatoUseCase. O `patientId` que veio no job (e o
    // gravado na Conversation) foi calculado antes e não é mais usado para
    // identificar ninguém: ele ficava congelado no primeiro paciente achado
    // pelo telefone — o mais antigo, quando havia mais de um.
    const identity = await this.resolverIdentidade.execute(contact);

    // K11 — quando a mensagem chegou ao webhook (gravada na parte síncrona,
    // ReceberMensagemWhatsAppUseCase): é a referência do pedido e da resposta,
    // nunca o horário de processamento na fila (ADR-0069, seção 2.3).
    const received = await this.conversationRepo.findMessageByExternalId(input.externalId);

    const result = await this.processarMensagem.execute({
      tenantId: input.tenantId,
      patientId: identity.status === 'recognized' ? identity.patientId : undefined,
      identityAmbiguous: identity.status === 'ambiguous',
      identityInactive: identity.status === 'inactive',
      contactId: contact.id,
      conversationHistory,
      message: input.message,
      correlationId: input.correlationId,
      whatsApp: received
        ? { conversationId: input.conversationId, messageId: input.externalId, receivedAt: received.createdAt }
        : undefined,
    });

    conversation.addMessage({ id: randomUUID(), direction: 'saida', content: result.responseMessage });
    await this.conversationRepo.appendMessages(conversation.pullPendingMessages(), input.tenantId);
    await this.auditService.recordAll(conversation.pullDomainEvents(), 'system');

    return { responseMessage: result.responseMessage, toPhoneNumber: conversation.phoneNumber };
  }
}
