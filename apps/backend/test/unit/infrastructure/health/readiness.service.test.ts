import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { READINESS_CHECK_TIMEOUT_MS, ReadinessService } from '@infrastructure/health/readiness.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';

/**
 * Tarefa 04 da auditoria — readiness. Aqui só a decisão (pronto / não pronto
 * / encerrando, prazo, log de transição); o Postgres e o Redis de verdade
 * ficam em test/critical/health-readiness.test.ts.
 */

const unusedModuleRef = {
  get: () => {
    throw new Error('ModuleRef não deveria ser consultado neste teste');
  },
} as unknown as ModuleRef;

class ReadinessWithProbes extends ReadinessService {
  constructor(
    private readonly database: () => Promise<void>,
    private readonly redisPing: () => Promise<void>,
  ) {
    super(unusedModuleRef);
  }

  protected pingDatabase(): Promise<void> {
    return this.database();
  }

  protected pingRedis(): Promise<void> {
    return this.redisPing();
  }
}

const up = () => Promise.resolve();
const down = () => Promise.reject(new Error('connection refused em db.interno:5432'));
const never = () => new Promise<void>(() => undefined);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ReadinessService', () => {
  it('pronto quando Postgres e Redis respondem', async () => {
    const report = await new ReadinessWithProbes(up, up).check();
    expect(report).toEqual({ status: 'ready', checks: { database: 'up', redis: 'up' } });
  });

  it.each([
    ['Postgres', down, up, { database: 'down', redis: 'up' }],
    ['Redis', up, down, { database: 'up', redis: 'down' }],
    ['os dois', down, down, { database: 'down', redis: 'down' }],
  ])('não pronto quando %s não responde, e diz qual', async (_name, database, redis, checks) => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const report = await new ReadinessWithProbes(database, redis).check();
    expect(report).toEqual({ status: 'not_ready', checks });
  });

  it('a resposta nunca carrega a mensagem de erro da dependência (host, usuário)', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const report = await new ReadinessWithProbes(down, up).check();
    expect(JSON.stringify(report)).not.toContain('db.interno');
  });

  it('dependência que não responde dentro do prazo conta como fora do ar — a sonda não fica pendurada', async () => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const pending = new ReadinessWithProbes(never, up).check();

    await vi.advanceTimersByTimeAsync(READINESS_CHECK_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({ status: 'not_ready', checks: { database: 'down', redis: 'up' } });
  });

  it('depois do início do encerramento responde "shutting_down" sem consultar dependência nenhuma', async () => {
    const database = vi.fn(up);
    const redis = vi.fn(up);
    const service = new ReadinessWithProbes(database, redis);

    service.onModuleDestroy();

    expect(await service.check()).toEqual({ status: 'shutting_down' });
    expect(database).not.toHaveBeenCalled();
    expect(redis).not.toHaveBeenCalled();
  });

  it('o SIGTERM marca o encerramento na hora, antes de o Nest começar a fechar os módulos', async () => {
    const before = process.listeners('SIGTERM');
    const service = new ReadinessWithProbes(up, up);
    service.onModuleInit();
    const added = process.listeners('SIGTERM').filter((listener) => !before.includes(listener));
    expect(added).toHaveLength(1);

    // Chamado direto: emitir o sinal de verdade derrubaria o processo de teste.
    (added[0] as () => void)();

    expect(await service.check()).toEqual({ status: 'shutting_down' });
    service.onModuleDestroy();
  });

  it('não deixa listener de sinal para trás ao ser destruído', () => {
    const counts = () => [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
    const before = counts();
    const service = new ReadinessWithProbes(up, up);

    service.onModuleInit();
    expect(counts()).toEqual([before[0] + 1, before[1] + 1]);

    service.onModuleDestroy();
    expect(counts()).toEqual(before);
  });

  it('registra só a mudança de estado, não uma linha por consulta', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    let databaseUp = false;
    const service = new ReadinessWithProbes(() => (databaseUp ? up() : down()), up);

    await service.check();
    await service.check();
    await service.check();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('database');
    expect(warn.mock.calls[0][0]).not.toContain('db.interno');

    databaseUp = true;
    await service.check();
    await service.check();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('database');
  });

  it('consulta o Postgres pelo cliente Prisma que a aplicação já tem, sem abrir outro', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ '?column?': 1 }]);
    const get = vi.fn().mockReturnValue({ $queryRaw: queryRaw });

    class RealDatabaseProbe extends ReadinessService {
      protected pingRedis(): Promise<void> {
        return Promise.resolve();
      }
    }
    const service = new RealDatabaseProbe({ get } as unknown as ModuleRef);

    expect(await service.check()).toEqual({ status: 'ready', checks: { database: 'up', redis: 'up' } });
    await service.check();

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(PrismaClientProvider, { strict: false });
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});
