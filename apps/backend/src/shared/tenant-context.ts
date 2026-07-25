import { Injectable, Scope } from '@nestjs/common';

/**
 * TenantContext — o único lugar do sistema que sabe "qual clínica é esta requisição".
 *
 * Fonte de verdade: docs/02-Arquitetura/07-Multitenancy.md, docs/04-API/00-Principios-da-API.md
 *
 * Regra crítica (nunca violar):
 *   O tenantId NUNCA vem de parâmetro de rota, body ou query string.
 *   Ele é extraído exclusivamente de um dos dois guards autorizados —
 *   JwtAuthGuard (JWT de usuário logado) ou TenantApiKeyGuard (chave de API
 *   por Tenant, PD-003, Business/Enterprise) — e injetado aqui. Nenhum
 *   outro ponto do código deve chamar `set()`.
 *   Qualquer endpoint que aceite tenant_id como input do cliente é falha de segurança
 *   (ver docs/04-API/00-Principios-da-API.md, seção "Autenticação e contexto de Tenant").
 *
 * Escopo REQUEST: uma instância nova por requisição HTTP — nunca compartilhado
 * entre requisições concorrentes de tenants diferentes.
 */
@Injectable({ scope: Scope.REQUEST })
export class TenantContext {
  private _tenantId: string | null = null;
  private _userId: string | null = null;

  /**
   * userId é `null` quando a requisição foi autenticada por API key
   * (TenantApiKeyGuard) — não existe um usuário humano real nesse caso.
   * AuditService trata isso automaticamente como actorType 'system'.
   */
  set(tenantId: string, userId: string | null): void {
    this._tenantId = tenantId;
    this._userId = userId;
  }

  get tenantId(): string {
    if (!this._tenantId) {
      throw new Error(
        'TenantContext acessado antes de ser inicializado — verifique se o AuthGuard rodou.',
      );
    }
    return this._tenantId;
  }

  get userId(): string | null {
    if (!this.isInitialized) {
      throw new Error('TenantContext.userId acessado antes de ser inicializado.');
    }
    return this._userId;
  }

  get isInitialized(): boolean {
    return this._tenantId !== null;
  }
}
