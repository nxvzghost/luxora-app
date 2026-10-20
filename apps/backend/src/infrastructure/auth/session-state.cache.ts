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
/** Papel gravado para usuário desativado. Nenhum papel real tem esse nome. */
const INACTIVE = 'inactive';
/** Versão gravada para usuário que não existe na clínica: qualquer versão real é maior. */
const MISSING_VERSION = -1;
/** `<versão>:<papel>` ou `<versão>:inactive`. */
const ENCODED_STATE = /^(-?\d+):([a-z_]+)$/;

/**
 * ADR-0067 — escrita monotônica. Sobrescreve a entrada só se ela não existir,
 * não for legível ou tiver versão de sessão menor ou igual à nova. Assim, um
 * `refresh()` que leu o banco antes de uma revogação (sair, desativar: os dois
 * incrementam a versão) e grava depois dela nunca devolve ao cache o estado
 * velho. Versão igual sobrescreve: é o caso da troca de papel e da reativação,
 * que não mudam a versão.
 */
const WRITE_IF_NOT_OLDER = `
local current = redis.call('GET', KEYS[1])
if current then
  local version = tonumber(string.match(current, '^(-?%d+):'))
  if version and version > tonumber(ARGV[2]) then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
return 1
`;

/** O estado como fica no cache: a versão vale também para o usuário desativado. */
interface StoredState {
  tokenVersion: number;
  /** `null` quando o usuário está desativado ou não existe na clínica. */
  role: string | null;
}

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
 * mude o estado, `refresh()` relê o banco e sobrescreve a entrada, mas nunca
 * com uma versão menor que a gravada (`WRITE_IF_NOT_OLDER`). A leitura só
 * grava se a chave não existir (`NX`). Nos dois casos, um valor velho lido
 * antes de uma revogação nunca apaga o valor novo.
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
    const stored = cached ?? (await this.readDatabase(tenantId, userId));
    if (cached === undefined) await this.writeIfAbsent(tenantId, userId, stored);
    return stored.role === null ? null : { tokenVersion: stored.tokenVersion, role: stored.role };
  }

  /**
   * Relê o banco e sobrescreve a entrada. Chamado depois de sair, desativar,
   * reativar e trocar o papel. Nunca lança: a gravação no banco já aconteceu
   * e é ela que vale. Se o banco não puder ser lido, a entrada é apagada,
   * para que a próxima requisição vá ao banco.
   */
  async refresh(tenantId: string, userId: string): Promise<void> {
    let stored: StoredState;
    try {
      stored = await this.readDatabase(tenantId, userId);
    } catch (error) {
      this.logger.warn(`Estado de sessão não relido do banco; entrada removida do cache: ${(error as Error).message}`);
      await this.runRedis((redis) => redis.del(this.key(tenantId, userId)));
      return;
    }
    await this.writeIfNotOlder(tenantId, userId, stored);
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
  private async readCache(tenantId: string, userId: string): Promise<StoredState | undefined> {
    const raw = await this.runRedis((redis) => redis.get(this.key(tenantId, userId)));
    if (raw === undefined || raw === null) return undefined;
    const match = ENCODED_STATE.exec(raw);
    if (!match) return undefined;
    return { tokenVersion: Number(match[1]), role: match[2] === INACTIVE ? null : match[2] };
  }

  private encode(stored: StoredState): string {
    return `${stored.tokenVersion}:${stored.role ?? INACTIVE}`;
  }

  private async writeIfAbsent(tenantId: string, userId: string, stored: StoredState): Promise<void> {
    const key = this.key(tenantId, userId);
    await this.runRedis((redis) => redis.set(key, this.encode(stored), 'EX', SESSION_STATE_TTL_SECONDS, 'NX'));
  }

  private async writeIfNotOlder(tenantId: string, userId: string, stored: StoredState): Promise<void> {
    const key = this.key(tenantId, userId);
    await this.runRedis((redis) =>
      redis.eval(WRITE_IF_NOT_OLDER, 1, key, this.encode(stored), String(stored.tokenVersion), String(SESSION_STATE_TTL_SECONDS)),
    );
  }

  /** Protegido para o teste crítico reproduzir a corrida entre uma leitura e uma revogação. */
  protected async readDatabase(tenantId: string, userId: string): Promise<StoredState> {
    const user = await this.clientProvider.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return (tx as PrismaClient).user.findFirst({
        where: { id: userId, tenantId },
        select: { tokenVersion: true, role: true, deletedAt: true },
      });
    });
    if (!user) return { tokenVersion: MISSING_VERSION, role: null };
    return { tokenVersion: user.tokenVersion, role: user.deletedAt ? null : user.role };
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
