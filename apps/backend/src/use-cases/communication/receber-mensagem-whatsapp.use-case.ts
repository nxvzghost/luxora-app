import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { TenantContext } from '@shared/tenant-context';
import { Conversation } from '@domain/communication/conversation.entity';
import { ConversationRepository, CONVERSATION_REPOSITORY } from '@domain-services/communication/conversation.repository';
import { PatientRepository, PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { WhatsAppInboundQueueProducer } from '@infrastructure/messaging/whatsapp-inbound-queue.producer';

export interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: Array<{ id: string; from: string; type: string; text?: { body: string } }>;
        statuses?: Array<{ id: string; status: string }>;
      };
    }>;
  }>;
}

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
 */
@Injectable()
export class ReceberMensagemWhatsAppUseCase {
  constructor(
    private readonly prismaClient: PrismaClientProvider,
    private readonly tenantContext: TenantContext,
    @Inject(CONVERSATION_REPOSITORY) private readonly conversationRepo: ConversationRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patientRepo: PatientRepository,
    private readonly auditService: AuditService,
    private readonly inboundQueue: WhatsAppInboundQueueProducer,
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
          if (message.type !== 'text' || !message.text?.body) continue; // só texto nesta AD
          await this.processInboundMessage(tenantId, message.id, message.from, message.text.body);
        }
        // statuses[] (entregue/lida) — fora do mínimo necessário desta AD;
        // Message.status permanece no valor padrão ('enviada') até uma AD
        // futura decidir tratar esses eventos.
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

    let conversation = await this.conversationRepo.findByTenantAndPhone(tenantId, fromPhoneNumber);
    const isNewConversation = !conversation;
    if (!conversation) {
      const patient = await this.patientRepo.findByPhone(fromPhoneNumber);
      conversation = Conversation.create({
        id: randomUUID(),
        tenantId,
        phoneNumber: fromPhoneNumber,
        patientId: patient?.id ?? null,
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
      patientId: conversation.patientId ?? undefined,
      message: body,
      externalId,
    });
  }
}
