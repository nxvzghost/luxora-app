import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export interface WhatsAppInboundJobData {
  tenantId: string;
  conversationId: string;
  patientId?: string;
  message: string;
  /** WAMID — mesmo valor usado como jobId (idempotência, ADR-0053 §5). */
  externalId: string;
  correlationId?: string;
}

/**
 * WhatsAppInboundQueueProducer — ADR-0053 §4/§5/§6. Fila nova, separada da
 * `messages` de saída (nunca reaproveitada) — mesma política de retry já
 * validada (attempts/backoff) e mesmo mecanismo de idempotência via jobId
 * (aqui, o WAMID em vez do idempotencyKey gerado pela aplicação).
 */
@Injectable()
export class WhatsAppInboundQueueProducer implements OnModuleDestroy {
  private readonly connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  private readonly queue = new Queue<WhatsAppInboundJobData>('whatsapp-inbound', { connection: this.connection });

  async enqueue(data: WhatsAppInboundJobData): Promise<void> {
    await this.queue.add('process-message', data, {
      jobId: data.externalId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
  }

  async onModuleDestroy() {
    await this.queue.close();
    await this.connection.quit();
  }
}
