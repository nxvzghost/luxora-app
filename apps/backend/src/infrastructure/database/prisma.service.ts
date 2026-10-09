import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, Scope } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenantContext } from '@shared/tenant-context';
import { PrismaClientProvider } from './prisma-client.provider';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface OpenUnitOfWork {
  tx: PrismaClient;
  tenantId: string;
}

/**
 * A unidade de trabalho em andamento neste fluxo assíncrono, se houver. É
 * uma só para o processo, e não um campo do PrismaService, porque cada
 * módulo declara o seu PrismaService: o repositório de auditoria (AuditModule)
 * e o de contatos (ContactModule), por exemplo, são instâncias diferentes e
 * precisam enxergar a mesma transação.
 */
const openUnitOfWork = new AsyncLocalStorage<OpenUnitOfWork>();

/**
 * PrismaService — request-scoped, mas LEVE: nunca cria conexão própria.
 * Sempre delega ao PrismaClientProvider singleton (ver Módulo 04 —
 * correção de um bug real de escala que a versão do Módulo 01 tinha).
 *
 * Fonte de verdade: docs/03-Database/09-Multi-Tenant.md, seção "Row-Level Security".
 */
@Injectable({ scope: Scope.REQUEST })
export class PrismaService {
  constructor(
    private readonly clientProvider: PrismaClientProvider,
    private readonly tenantContext: TenantContext,
  ) {}

  /**
   * Executa um bloco de queries dentro de uma transação com app.tenant_id setado.
   * Uso obrigatório em todo Repository que acessa dado multi-tenant.
   *
   * Dentro de uma unidade de trabalho (inUnitOfWork) o bloco entra na
   * transação que já está aberta, em vez de abrir a sua. Fora de uma, o
   * comportamento é o de sempre: uma transação por chamada.
   */
  async forTenant<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    const tenantId = this.validatedTenantId();

    const open = openUnitOfWork.getStore();
    if (open) {
      this.assertSameTenant(open, tenantId);
      return fn(open.tx);
    }

    return this.clientProvider.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
      return fn(tx as PrismaClient);
    });
  }

  /**
   * ADR-0063 (AD-038) — unidade de trabalho: UMA transação para tudo o que
   * for gravado dentro de `work`, por qualquer repositório e pelo
   * AuditService. Ou tudo é confirmado, ou nada é: se `work` lançar, a
   * transação inteira é desfeita.
   *
   * É opcional e explícita. Nenhum fluxo que não a chame muda de
   * comportamento — forTenant() só entra numa transação aberta por aqui.
   *
   * O isolamento entre clínicas é o de forTenant(): app.tenant_id é
   * definido uma vez, no início, e vale para a transação toda. Um
   * repositório de outra clínica que tente entrar nela é recusado.
   */
  async inUnitOfWork<T>(work: () => Promise<T>): Promise<T> {
    const tenantId = this.validatedTenantId();

    const open = openUnitOfWork.getStore();
    if (open) {
      this.assertSameTenant(open, tenantId);
      return work();
    }

    return this.clientProvider.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
      return openUnitOfWork.run({ tx: tx as PrismaClient, tenantId }, work);
    });
  }

  /** Há uma unidade de trabalho aberta neste fluxo? Uma trava de linha só faz sentido dentro de uma. */
  get isInUnitOfWork(): boolean {
    return openUnitOfWork.getStore() !== undefined;
  }

  /**
   * Exceção deliberada e restrita — ver o comentário completo em
   * prisma/rls/enable-rls.sql.
   *
   * Dois usos legítimos, cada um com sua própria policy de RLS estreita:
   *   1. Localizar um User por email antes de saber o tenantId (fluxo de
   *      login, ADR-0024) — policy `auth_lookup_by_email`.
   *   2. Localizar um TenantApiKey pelo hash antes de saber o tenantId
   *      (TenantApiKeyGuard, PD-003) — policy `api_key_lookup_by_hash`.
   * NUNCA usar para qualquer outra finalidade sem adicionar uma nova
   * policy própria e igualmente restrita — isso enxerga linhas de TODOS os
   * Tenants na tabela consultada.
   *
   * Nunca entra em uma unidade de trabalho: abre sempre a própria transação.
   */
  async forAuthLookup<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return this.clientProvider.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.bypass_tenant_check = 'true'`);
      return fn(tx as PrismaClient);
    });
  }

  private validatedTenantId(): string {
    const tenantId = this.tenantContext.tenantId; // lança erro se não inicializado — nunca query "sem tenant" por omissão

    if (!UUID_REGEX.test(tenantId)) {
      throw new Error(`tenantId em formato inválido, recusando executar query: ${tenantId}`);
    }
    return tenantId;
  }

  private assertSameTenant(open: OpenUnitOfWork, tenantId: string): void {
    if (open.tenantId !== tenantId) {
      throw new Error('Unidade de trabalho aberta para outra clínica — recusando executar query dentro dela.');
    }
  }
}
