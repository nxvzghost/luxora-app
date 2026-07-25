import { Injectable, Scope } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenantContext } from '@shared/tenant-context';
import { PrismaClientProvider } from './prisma-client.provider';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
   */
  async forTenant<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    const tenantId = this.tenantContext.tenantId; // lança erro se não inicializado — nunca query "sem tenant" por omissão

    if (!UUID_REGEX.test(tenantId)) {
      throw new Error(`tenantId em formato inválido, recusando executar query: ${tenantId}`);
    }

    return this.clientProvider.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
      return fn(tx as PrismaClient);
    });
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
   */
  async forAuthLookup<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return this.clientProvider.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.bypass_tenant_check = 'true'`);
      return fn(tx as PrismaClient);
    });
  }
}
