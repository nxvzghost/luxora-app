import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ContextIdFactory, ModuleRef } from '@nestjs/core';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { TenantContext } from '@shared/tenant-context';
import { ProcessarMensagemWhatsAppUseCase } from '@use-cases/communication/processar-mensagem-whatsapp.use-case';
import { WhatsAppInboundJobData } from './whatsapp-inbound-queue.producer';

/**
 * WhatsAppInboundQueueWorker — ADR-0053 §4/§6.
 *
 * TenantContext/PrismaService (Scope.REQUEST) não sobrevivem à fronteira
 * do BullMQ — mesma limitação estrutural já documentada em ADR-0051 para
 * MessageQueueWorker. A diferença: MessageQueueWorker nunca precisou
 * disso, porque EnviarMensagemUseCase recebe tenantId explícito e nunca
 * toca TenantContext ambiente. ProcessarMensagemWhatsAppUseCase, por
 * reaproveitar ProcessarMensagemUseCase/IntentActionRouter SEM alteração
 * (restrição aprovada: "preservação integral da arquitetura existente"),
 * herda a dependência transitiva de AgendarConsultaUseCase/etc em
 * `this.tenantContext.tenantId` ambiente.
 *
 * Solução: mecanismo padrão do NestJS para resolver providers REQUEST-
 * scoped fora de uma requisição HTTP real — um `contextId` sintético,
 * único por job, garantindo que TenantContext e tudo que dele depende
 * (transitivamente, até dentro do IntentActionRouter) compartilhem o
 * mesmo tenantId durante o processamento deste job, sem nunca vazar entre
 * jobs concorrentes. Não é um mecanismo de auditoria/idempotência
 * paralelo (restrição respeitada) — é a plumbing de DI necessária para
 * reaproveitar os Use Cases existentes sem modificá-los.
 */
@Injectable()
export class WhatsAppInboundQueueWorker implements OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppInboundQueueWorker.name);
  private readonly connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  private readonly worker: Worker<WhatsAppInboundJobData>;

  constructor(private readonly moduleRef: ModuleRef) {
    this.worker = new Worker<WhatsAppInboundJobData>(
      'whatsapp-inbound',
      async (job) => {
        const correlationId = job.data.correlationId ?? randomUUID();
        this.logger.log(`[correlationId=${correlationId}] Processando job ${job.id} da fila 'whatsapp-inbound'.`);

        const contextId = ContextIdFactory.create();
        const tenantContext = await this.moduleRef.resolve(TenantContext, contextId, { strict: false });
        tenantContext.set(job.data.tenantId, null);

        const processarMensagemWhatsApp = await this.moduleRef.resolve(ProcessarMensagemWhatsAppUseCase, contextId, {
          strict: false,
        });
        await processarMensagemWhatsApp.execute({ ...job.data, correlationId });

        this.logger.log(`[correlationId=${correlationId}] Job ${job.id} concluído.`);
      },
      { connection: this.connection },
    );
  }

  async onModuleDestroy() {
    await this.worker.close();
    await this.connection.quit();
  }
}
