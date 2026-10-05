import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ContextIdFactory, ModuleRef } from '@nestjs/core';
import { Job, UnrecoverableError, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { TenantContext } from '@shared/tenant-context';
import { MessageProviderError } from '@domain-services/communication/message-provider';
import { EnviarMensagemUseCase } from '@use-cases/communication/enviar-mensagem.use-case';
import { MessageJobData } from './message-queue.producer';
import { outboundRetryDelayMs } from './outbound-retry';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * MessageQueueWorker — consome a fila 'messages' e delega ao Use Case
 * (que já tem sua própria idempotência de 2 camadas — este worker é a
 * 3ª linha de defesa, via jobId do BullMQ, não a única).
 *
 * Fase 3 da auditoria — ACHADO REAL, corrigido aqui: este worker injetava
 * EnviarMensagemUseCase no construtor. A cadeia EnviarMensagemUseCase →
 * PrismaMessageLogRepository → PrismaService é Scope.REQUEST, e no NestJS
 * o escopo de requisição sobe para quem depende dele: o próprio worker
 * virava Scope.REQUEST e nunca era instanciado no boot. A fila acumulava
 * jobs sem nenhum consumidor (limitação já descrita na ADR-0051, nunca
 * corrigida até aqui).
 *
 * Solução — a mesma de WhatsAppInboundQueueWorker (ADR-0053/ADR-0054): o
 * worker depende só de ModuleRef (singleton, instanciado no boot) e, a
 * cada job, cria um `contextId` próprio, preenche o TenantContext desse
 * contexto com o `tenantId` do payload e só então resolve o Use Case.
 * Nenhuma requisição HTTP participa; um job nunca enxerga o TenantContext
 * de outro.
 *
 * O `tenantId` do payload é a única fonte de identidade do job: quem
 * enfileira o preenche a partir do contexto já autenticado (nunca de
 * entrada do cliente), e a credencial de envio é buscada por esse mesmo
 * id. Um payload sem tenantId em formato válido é falha permanente.
 *
 * Repetição: MessageProviderError com `retryable: false` e payload
 * inválido viram UnrecoverableError — o BullMQ encerra o job sem novas
 * tentativas. Todo o resto segue a política de MessageQueueProducer
 * (3 tentativas, espera exponencial).
 *
 * Encerramento (Fase 3B): onModuleDestroy() fecha o worker de forma
 * graciosa — ele para de pegar jobs novos e espera o que está em andamento
 * terminar. main.ts liga isso ao SIGTERM (enableShutdownHooks), para um
 * deploy não cortar um envio no meio.
 */
@Injectable()
export class MessageQueueWorker implements OnModuleDestroy {
  private readonly logger = new Logger(MessageQueueWorker.name);
  private readonly connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  private readonly worker: Worker<MessageJobData>;

  constructor(private readonly moduleRef: ModuleRef) {
    this.worker = new Worker<MessageJobData>('messages', (job) => this.process(job), {
      connection: this.connection,
      // Fase 3B — espera entre tentativas: 2 s e 4 s, ou o `Retry-After` do
      // provider dentro de piso e teto próprios (ver outbound-retry.ts). Só
      // vale para jobs enfileirados com o tipo de espera da fila de saída.
      settings: { backoffStrategy: (attemptsMade, _type, err) => outboundRetryDelayMs(attemptsMade, err) },
    });

    // Nunca registra `job.data` (telefone e texto da mensagem) — só o
    // necessário para localizar o job e o motivo já sanitizado.
    this.worker.on('failed', (job, err) => {
      const correlationId = job?.data?.correlationId ?? 'desconhecido';
      const attemptsMade = job?.attemptsMade ?? 0;
      const maxAttempts = job?.opts?.attempts ?? 1;
      const final = err instanceof UnrecoverableError || attemptsMade >= maxAttempts;
      this.logger.warn(
        `[correlationId=${correlationId}] Job ${job?.id} da fila 'messages' falhou (tentativa ${attemptsMade}/${maxAttempts}, ${final ? 'definitivo' : 'será repetido'}): ${err.message}`,
      );
    });
  }

  private async process(job: Job<MessageJobData>): Promise<void> {
    // AD-016 — TenantContext/CorrelationContext (Scope.REQUEST) não
    // sobrevivem à fronteira do BullMQ (ver ADR-0051); o correlationId
    // já veio serializado em job.data (MessageQueueProducer.enqueue()).
    // Quando ausente (job enfileirado antes desta AD, ou chamador que
    // não tinha um correlationId de origem), gera um próprio deste job
    // — deixa explícito no log que a correlação não veio de uma
    // requisição HTTP original.
    const correlationId = job.data.correlationId ?? randomUUID();
    this.logger.log(`[correlationId=${correlationId}] Processando job ${job.id} da fila 'messages'.`);

    const tenantId = job.data.tenantId;
    if (typeof tenantId !== 'string' || !UUID_REGEX.test(tenantId)) {
      throw new UnrecoverableError("Job da fila 'messages' sem tenantId válido no payload — descartado.");
    }

    const contextId = ContextIdFactory.create();
    const tenantContext = await this.moduleRef.resolve(TenantContext, contextId, { strict: false });
    tenantContext.set(tenantId, null);

    const enviarMensagem = await this.moduleRef.resolve(EnviarMensagemUseCase, contextId, { strict: false });

    try {
      await enviarMensagem.execute({ ...job.data, correlationId });
    } catch (err) {
      if (err instanceof MessageProviderError && !err.retryable) {
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }

    this.logger.log(`[correlationId=${correlationId}] Job ${job.id} concluído.`);
  }

  async onModuleDestroy() {
    await this.worker.close();
    await this.connection.quit();
  }
}
