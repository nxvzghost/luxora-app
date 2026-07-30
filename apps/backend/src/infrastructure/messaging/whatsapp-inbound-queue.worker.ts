import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ContextIdFactory, ModuleRef } from '@nestjs/core';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { TenantContext } from '@shared/tenant-context';
import { ProcessarMensagemWhatsAppUseCase, ProcessarMensagemWhatsAppResult } from '@use-cases/communication/processar-mensagem-whatsapp.use-case';
import { INBOX_REPOSITORY, InboxRepository } from '@domain-services/platform/inbox.repository';
import { MessageQueueProducer } from './message-queue.producer';
import { WhatsAppInboundJobData } from './whatsapp-inbound-queue.producer';

const CHANNEL = 'whatsapp';

/**
 * WhatsAppInboundQueueWorker — ADR-0053 §4/§6, máquina de estados
 * revisada por ADR-0054 (AD-036).
 *
 * TenantContext/PrismaService (Scope.REQUEST) não sobrevivem à fronteira
 * do BullMQ — mesma limitação estrutural já documentada em ADR-0051 para
 * MessageQueueWorker. Solução: um `contextId` sintético por job via
 * ModuleRef/ContextIdFactory (mecanismo oficial do NestJS), garantindo
 * que TenantContext, InboxRepository (também REQUEST-scoped, por
 * depender transitivamente de PrismaService) e
 * ProcessarMensagemWhatsAppUseCase compartilhem o mesmo tenantId durante
 * o processamento deste job.
 *
 * Fase 1 (IA + IntentActionRouter + persistência + auditoria, dentro de
 * ProcessarMensagemWhatsAppUseCase.execute()) e Fase 2 (despacho, agora
 * responsabilidade deste worker) são passos distintos e observáveis,
 * separados por um checkpoint (`InboxRepository.markGenerated()`) — é
 * essa separação que garante que um retry do BullMQ nunca reexecute a
 * Fase 1 depois dela já ter tido sucesso (ver ADR-0054 §Ponto 1/§Ponto 2
 * para o raciocínio completo, incluindo por que um ciclo de 2 estados não
 * bastava).
 *
 * REGRA NÃO NEGOCIÁVEL: `markFailed()` só pode ser chamado a partir do
 * catch que envolve a Fase 1. Uma falha na Fase 2 (despacho) nunca chama
 * `markFailed()` — a exceção só propaga para o BullMQ aplicar sua própria
 * política de retry; a tentativa seguinte lê o estado 'generated' via
 * `tryClaim()` e cai direto no branch de retomada, sem jamais rechamar a
 * IA.
 */
@Injectable()
export class WhatsAppInboundQueueWorker implements OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppInboundQueueWorker.name);
  private readonly connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  private readonly worker: Worker<WhatsAppInboundJobData>;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly outboundQueue: MessageQueueProducer,
  ) {
    this.worker = new Worker<WhatsAppInboundJobData>(
      'whatsapp-inbound',
      async (job) => {
        const correlationId = job.data.correlationId ?? randomUUID();
        this.logger.log(`[correlationId=${correlationId}] Processando job ${job.id} da fila 'whatsapp-inbound'.`);

        const contextId = ContextIdFactory.create();
        const tenantContext = await this.moduleRef.resolve(TenantContext, contextId, { strict: false });
        tenantContext.set(job.data.tenantId, null);

        const inbox = await this.moduleRef.resolve<InboxRepository>(INBOX_REPOSITORY, contextId, { strict: false });

        const claim = await inbox.tryClaim({
          channel: CHANNEL,
          externalId: job.data.externalId,
          tenantId: job.data.tenantId,
          conversationId: job.data.conversationId,
          correlationId,
        });

        if (claim.outcome === 'in_progress') {
          this.logger.warn(
            `[correlationId=${correlationId}] Job ${job.id} já possui um claim ativo em 'inbound_processing_inbox' — ignorando esta execução para evitar processamento concorrente.`,
          );
          return;
        }

        if (claim.outcome === 'resume_dispatch') {
          this.logger.log(
            `[correlationId=${correlationId}] Job ${job.id}: Fase 1 já concluída anteriormente — retomando só o despacho (Fase 2), sem chamar a IA de novo.`,
          );
          await this.dispatchAndComplete(job.data, claim.resultPayload, correlationId, inbox, job.id ?? job.data.externalId);
          this.logger.log(`[correlationId=${correlationId}] Job ${job.id} concluído (retomada).`);
          return;
        }

        // claim.outcome === 'claimed' — Fase 1.
        let result: ProcessarMensagemWhatsAppResult;
        try {
          const processarMensagemWhatsApp = await this.moduleRef.resolve(ProcessarMensagemWhatsAppUseCase, contextId, {
            strict: false,
          });
          result = await processarMensagemWhatsApp.execute(job.data);
          await inbox.markGenerated(CHANNEL, job.data.externalId, result);
        } catch (err) {
          await inbox.markFailed(CHANNEL, job.data.externalId, (err as Error).message);
          throw err;
        }

        // Fase 2 — checkpoint da Fase 1 já gravado; a partir daqui nunca
        // mais markFailed() para este evento.
        await this.dispatchAndComplete(job.data, result, correlationId, inbox, job.id ?? job.data.externalId);

        this.logger.log(`[correlationId=${correlationId}] Job ${job.id} concluído.`);
      },
      { connection: this.connection },
    );
  }

  private async dispatchAndComplete(
    jobData: WhatsAppInboundJobData,
    result: ProcessarMensagemWhatsAppResult,
    correlationId: string,
    inbox: InboxRepository,
    jobLabel: string,
  ): Promise<void> {
    try {
      await this.outboundQueue.enqueue({
        tenantId: jobData.tenantId,
        toPhoneNumber: result.toPhoneNumber,
        body: result.responseMessage,
        idempotencyKey: `conversation-reply-${jobData.externalId}`,
        correlationId,
      });
      await inbox.markDispatched(CHANNEL, jobData.externalId);
    } catch (err) {
      this.logger.warn(
        `[correlationId=${correlationId}] Job ${jobLabel}: falha ao despachar (Fase 2) — Inbox permanece em 'generated', a próxima tentativa só reenvia, nunca rechama a IA. Erro: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  async onModuleDestroy() {
    await this.worker.close();
    await this.connection.quit();
  }
}
