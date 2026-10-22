import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { ContextIdFactory, ModulesContainer } from '@nestjs/core';
import { bootstrapTestApp } from './support/bootstrap-app';
import { DatabaseModule } from '@infrastructure/database/database.module';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { PrismaService } from '@infrastructure/database/prisma.service';

/**
 * [CRÍTICO] Um único PrismaClient na aplicação real (AppModule inteiro).
 *
 * Antes, PrismaClientProvider era declarado em 17 módulos: 17 instâncias, 17
 * pools, 17 conexões logo após o boot. Com 4 arquivos da Suíte Crítica em
 * paralelo e connection_limit=4, o Postgres recusou conexões no CI
 * 39737046589 ("Too many database connections") e três testes receberam 500.
 *
 * Prova, com o grafo de módulos de verdade: o Nest registra o provider só no
 * DatabaseModule; o PrismaService de cada módulo e todo serviço que injeta o
 * cliente direto recebem a mesma instância; há um $connect no boot e um
 * $disconnect no encerramento.
 */

let app: INestApplication;
let closed = false;
const connectSpy = vi.spyOn(PrismaClientProvider.prototype, 'onModuleInit');
const disconnectSpy = vi.spyOn(PrismaClientProvider.prototype, 'onModuleDestroy');

beforeAll(async () => {
  app = await bootstrapTestApp();
}, 60_000);

afterAll(async () => {
  if (!closed) await app?.close();
  vi.restoreAllMocks();
});

function modules() {
  return [...app.get(ModulesContainer).values()];
}

describe('[CRÍTICO] PrismaClientProvider — uma instância para a aplicação inteira', () => {
  it('o Nest registra o provider só no DatabaseModule', () => {
    const hosts = modules()
      .filter((module) => module.providers.has(PrismaClientProvider))
      .map((module) => module.metatype);

    expect(hosts).toEqual([DatabaseModule]);
  });

  it('o PrismaService de cada módulo delega ao mesmo cliente', async () => {
    const shared = app.get(PrismaClientProvider);
    const withService = modules().filter((module) => module.providers.has(PrismaService));
    expect(withService.length).toBeGreaterThan(10);

    const contextId = ContextIdFactory.create();
    for (const module of withService) {
      const service = await app.select(module.metatype).resolve(PrismaService, contextId, { strict: true });
      expect((service as unknown as { clientProvider: unknown }).clientProvider).toBe(shared);
    }
  });

  it('todo serviço que injeta o cliente direto recebe a mesma instância', () => {
    const shared = app.get(PrismaClientProvider);
    const injected = new Set<unknown>();
    let consumers = 0;
    for (const module of modules()) {
      for (const wrapper of module.providers.values()) {
        const instance: unknown = wrapper.isDependencyTreeStatic() ? wrapper.instance : undefined;
        if (!instance || typeof instance !== 'object' || instance instanceof PrismaClientProvider) continue;
        for (const value of Object.values(instance)) {
          if (value instanceof PrismaClientProvider) {
            injected.add(value);
            consumers += 1;
          }
        }
      }
    }

    // SessionStateCache, AuthService, ReadinessService (resolve sob demanda),
    // repositórios de usuário, paciente, feriado, assinatura e afins.
    expect(consumers).toBeGreaterThan(3);
    expect([...injected]).toEqual([shared]);
  });

  it('um único $connect no boot', () => {
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(connectSpy.mock.contexts[0]).toBe(app.get(PrismaClientProvider));
  });

  it('um único $disconnect no encerramento, no cliente compartilhado', async () => {
    const shared = app.get(PrismaClientProvider);
    expect(disconnectSpy).not.toHaveBeenCalled();

    await app.close();
    closed = true;

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(disconnectSpy.mock.contexts[0]).toBe(shared);
  });
});
