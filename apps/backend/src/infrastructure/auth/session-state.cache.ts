import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import IORedis from 'ioredis';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';

/** O que precisa bater entre um access token e o usuário para a requisição valer. */
export interface SessionState {
  tokenVersion: number;
  role: string;
}

/**
 * Quanto tempo o estado fica no Redis sem ser relido do banco. Toda gravação
 * que muda o estado sobrescreve a entrada na hora (`refresh()`); o prazo só
 * limita o atraso se essa sobrescrita falhar com o Redis no ar.
 */
export const SESSION_STATE_TTL_SECONDS = 60;
const REDIS_COMMAND_TIMEOUT_MS = 500;
const KEY_PREFIX = 'luxora:session-state';
const INACTIVE = 'inactive';
const ENCODED_STATE = /^(\d+):([a-z_]+)$/;

/** A chave de um usuário no Redis. Por clínica e usuário: o estado lido sob a RLS de uma clínica nunca serve a outra. */
export function sessionStateKey(tenantId: string, userId: string): string {
  return `${KEY_PREFIX}:${tenantId}:${userId}`;
}

/**
 * SessionStateCache — ADR-0067 (A-17). Estado vigente da sessão de cada
 * usuário: a versão de sessão (`User.tokenVersion`, ADR-0056), o papel e se
 * ele está ativo. O `JwtAuthGuard` compara o access token com este estado a
 * cada requisição, o que torna sair, desativar e trocar o papel imediatos.
 *
 * Leitura: Redis primeiro; na falta da entrada, ou com o Redis fora do ar, o
 * banco, dentro de uma transação escopada à clínica do token (a RLS garante
 * que o usuário é dessa clínica). Escrita: depois de qualquer gravação que
 * mude o estado, `refresh()` relê o banco e sobrescreve a entrada. A leitura
 * só grava se a chave não existir (`NX`): um valor velho lido antes de uma
 * revogação nunca apaga o valor novo.
 */
@Injectable()
export class SessionStateCache implements OnModuleDestroy {
  private readonly logger = new Logger(SessionStateCache.name);
  private redis?: IORedis;
  private redisFailing = false;

  constructor(private readonly clientProvider: PrismaClientProvider) {}

  /** O estado vigente, ou `null` se o usuário não existe nesta clínica ou está desativado. */
  async current(tenantId: string, userId: string): Promise<SessionState | null> {
    const cached = await this.readCache(tenantId, userId);
    if (cached !== undefined) return cached;
    const state = await this.readDatabase(tenantId, userId);
    await this.writeCache(tenantId, userId, state, true);
    return state;
  }

  /**
   * Relê o banco e sobrescreve a entrada. Chamado depois de sair, desativar,
   * reativar e trocar o papel. Nunca lança: a gravação no banco já aconteceu
   * e é ela que vale. Se o banco não puder ser lido, a entrada é apagada,
   * para que a próxima requisição vá ao banco.
   */
  async refresh(tenantId: string, userId: string): Promise<void> {
    let state: SessionState | null;
    try {
      state = await this.readDatabase(tenantId, userId);
    } catch (error) {
      this.logger.warn(`Estado de sessão não relido do banco; entrada removida do cache: ${(error as Error).message}`);
      await this.runRedis((redis) => redis.del(this.key(tenantId, userId)));
      return;
    }
    await this.writeCache(tenantId, userId, state, false);
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  private key(tenantId: string, userId: string): string {
    return sessionStateKey(tenantId, userId);
  }

  /** `undefined` quando a entrada não existe, não é legível ou o Redis falhou — nos três casos, vale o banco. */
  private async readCache(tenantId: string, userId: string): Promise<SessionState | null | undefined> {
    const raw = await this.runRedis((redis) => redis.get(this.key(tenantId, userId)));
    if (raw === undefined || raw === null) return undefined;
    if (raw === INACTIVE) return null;
    const match = ENCODED_STATE.exec(raw);
    return match ? { tokenVersion: Number(match[1]), role: match[2] } : undefined;
  }

  private async writeCache(tenantId: string, userId: string, state: SessionState | null, onlyIfAbsent: boolean): Promise<void> {
    const value = state ? `${state.tokenVersion}:${state.role}` : INACTIVE;
    const key = this.key(tenantId, userId);
    await this.runRedis((redis) =>
      onlyIfAbsent
        ? redis.set(key, value, 'EX', SESSION_STATE_TTL_SECONDS, 'NX')
        : redis.set(key, value, 'EX', SESSION_STATE_TTL_SECONDS),
    );
  }

  private async readDatabase(tenantId: string, userId: string): Promise<SessionState | null> {
    const user = await this.clientProvider.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return (tx as PrismaClient).user.findFirst({
        where: { id: userId, tenantId },
        select: { tokenVersion: true, role: true, deletedAt: true },
      });
    });
    if (!user || user.deletedAt) return null;
    return { tokenVersion: user.tokenVersion, role: user.role };
  }

  /** Executa um comando no Redis; falha vira `undefined` (o chamador recorre ao banco). Avisa no log só na transição. */
  private async runRedis<T>(command: (redis: IORedis) => Promise<T>): Promise<T | undefined> {
    try {
      const result = await command(this.redisClient());
      if (this.redisFailing) {
        this.redisFailing = false;
        this.logger.log('Redis de volta: o estado de sessão volta a ser lido do cache.');
      }
      return result;
    } catch (error) {
      if (!this.redisFailing) {
        this.redisFailing = true;
        this.logger.warn(`Redis indisponível: o estado de sessão passa a ser lido do banco (${(error as Error).message}).`);
      }
      return undefined;
    }
  }

  private redisClient(): IORedis {
    if (!this.redis) {
      this.redis = this.createRedisClient();
      // Sem listener, o ioredis escreve "Unhandled error event" a cada queda.
      this.redis.on('error', () => undefined);
    }
    return this.redis;
  }

  /** Protegido para o teste crítico apontar para um Redis fora do ar. */
  protected createRedisClient(): IORedis {
    return new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      connectTimeout: REDIS_COMMAND_TIMEOUT_MS,
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
      // Falha depois de uma tentativa de reconexão, em vez de segurar a
      // requisição esperando o Redis voltar.
      maxRetriesPerRequest: 1,
    });
  }
}
