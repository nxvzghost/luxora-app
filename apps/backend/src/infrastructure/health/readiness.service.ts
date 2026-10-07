import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import IORedis from 'ioredis';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';

export type DependencyState = 'up' | 'down';

export interface ReadinessReport {
  status: 'ready' | 'not_ready' | 'shutting_down';
  /** Ausente durante o encerramento: nenhuma dependência é consultada. */
  checks?: { database: DependencyState; redis: DependencyState };
}

/** Prazo de cada verificação. Dependência que não responde nesse tempo conta como fora do ar. */
export const READINESS_CHECK_TIMEOUT_MS = 2000;

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/**
 * ReadinessService — Tarefa 04 da auditoria (deploy e operação).
 *
 * Responde "esta instância pode receber tráfego agora?". É diferente do
 * liveness (GET /health), que só diz que o processo está de pé e por isso
 * não consulta dependência nenhuma: um Postgres fora do ar não pode fazer a
 * plataforma reiniciar o container em laço.
 *
 * Verifica as duas dependências sem as quais nenhuma rota útil funciona:
 *   - Postgres: `SELECT 1` pelo cliente Prisma que a aplicação já usa (o
 *     mesmo usuário e a mesma URL de runtime — nenhum pool novo é aberto);
 *   - Redis: `PING` por uma conexão própria, criada na primeira consulta.
 *
 * Durante o encerramento gracioso (SIGTERM) responde "shutting_down" desde o
 * primeiro instante, para o balanceador parar de enviar requisições
 * enquanto os workers das filas terminam o job em andamento.
 *
 * A resposta traz só "up"/"down" — nunca host, usuário ou mensagem de erro.
 */
@Injectable()
export class ReadinessService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReadinessService.name);
  private readonly lastState: Record<string, DependencyState | undefined> = {};
  private prisma?: PrismaClientProvider;
  private redis?: IORedis;
  private shuttingDown = false;

  // `once`, pelo mesmo motivo de tracing.ts: um listener permanente de sinal
  // tira do Node o comportamento padrão de terminar.
  private readonly markShuttingDown = (): void => {
    this.shuttingDown = true;
  };

  constructor(private readonly moduleRef: ModuleRef) {}

  onModuleInit(): void {
    for (const signal of SHUTDOWN_SIGNALS) process.once(signal, this.markShuttingDown);
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    for (const signal of SHUTDOWN_SIGNALS) process.removeListener(signal, this.markShuttingDown);
    this.redis?.disconnect();
    this.redis = undefined;
  }

  async check(): Promise<ReadinessReport> {
    if (this.shuttingDown) return { status: 'shutting_down' };

    const [database, redis] = await Promise.all([
      this.probe('database', () => this.pingDatabase()),
      this.probe('redis', () => this.pingRedis()),
    ]);
    const ready = database === 'up' && redis === 'up';
    return { status: ready ? 'ready' : 'not_ready', checks: { database, redis } };
  }

  protected async pingDatabase(): Promise<void> {
    this.prisma ??= this.moduleRef.get(PrismaClientProvider, { strict: false });
    await this.prisma.$queryRaw`SELECT 1`;
  }

  protected async pingRedis(): Promise<void> {
    await this.redisClient().ping();
  }

  private redisClient(): IORedis {
    if (!this.redis) {
      this.redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
        lazyConnect: true,
        connectTimeout: READINESS_CHECK_TIMEOUT_MS,
        // O PING falha depois de uma tentativa de reconexão, em vez de ficar
        // na fila esperando o Redis voltar.
        maxRetriesPerRequest: 1,
      });
      // Sem listener, o ioredis escreve "Unhandled error event" a cada queda.
      // A queda já aparece como "down" na resposta e no log de transição.
      this.redis.on('error', () => undefined);
    }
    return this.redis;
  }

  private async probe(name: 'database' | 'redis', ping: () => Promise<void>): Promise<DependencyState> {
    let timer: NodeJS.Timeout | undefined;
    let state: DependencyState;
    try {
      await Promise.race([
        ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), READINESS_CHECK_TIMEOUT_MS);
        }),
      ]);
      state = 'up';
    } catch {
      state = 'down';
    } finally {
      if (timer) clearTimeout(timer);
    }

    // Só a mudança de estado é registrada: a sonda roda a cada poucos
    // segundos, e uma linha por consulta afogaria o log durante uma queda.
    if (this.lastState[name] !== state) {
      if (state === 'down') this.logger.warn(`Dependência "${name}" fora do ar — instância não está pronta.`);
      else if (this.lastState[name] === 'down') this.logger.log(`Dependência "${name}" voltou a responder.`);
      this.lastState[name] = state;
    }
    return state;
  }
}
