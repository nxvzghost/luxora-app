import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { EnviarMensagemUseCase } from '@use-cases/communication/enviar-mensagem.use-case';
import { MessageJobData } from './message-queue.producer';

/**
 * MessageQueueWorker — consome a fila 'messages' e delega ao Use Case
 * (que já tem sua própria idempotência de 2 camadas — este worker é a
 * 3ª linha de defesa, via jobId do BullMQ, não a única).
 *
 * NÃO EXECUTADO NESTE AMBIENTE (sem Redis real disponível) — código
 * completo, pendente de validação empírica junto com o restante da
 * infraestrutura (mesma pendência desde o Módulo 01).
 */
@Injectable()
export class MessageQueueWorker implements OnModuleDestroy {
  private readonly connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  private readonly worker: Worker<MessageJobData>;

  constructor(private readonly enviarMensagem: EnviarMensagemUseCase) {
    this.worker = new Worker<MessageJobData>(
      'messages',
      async (job) => {
        await this.enviarMensagem.execute(job.data);
      },
      { connection: this.connection },
    );
  }

  async onModuleDestroy() {
    await this.worker.close();
    await this.connection.quit();
  }
}
