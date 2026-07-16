import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export interface MessageJobData {
  tenantId: string;
  toPhoneNumber: string;
  body: string;
  idempotencyKey: string;
}

/**
 * MessageQueueProducer — Módulo 11.
 * Fonte: 02 - CTO/clinicos/docs/02-Arquitetura/09-Filas.md.
 *
 * BullMQ usa o idempotencyKey como jobId — isso dá uma TERCEIRA camada de
 * proteção contra duplicação, gratuita: BullMQ nunca aceita dois jobs com
 * o mesmo id na mesma fila, então nem chega a enfileirar duas vezes o
 * mesmo envio, antes mesmo de tocar o Use Case ou o banco.
 */
@Injectable()
export class MessageQueueProducer implements OnModuleDestroy {
  private readonly connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  private readonly queue = new Queue<MessageJobData>('messages', { connection: this.connection });

  async enqueue(data: MessageJobData): Promise<void> {
    await this.queue.add('send-message', data, {
      jobId: data.idempotencyKey, // 3ª camada de idempotência — gratuita, nativa do BullMQ
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
  }

  async onModuleDestroy() {
    await this.queue.close();
    await this.connection.quit();
  }
}
