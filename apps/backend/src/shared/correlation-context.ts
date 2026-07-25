import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { Request } from 'express';

/**
 * Chave usada para pendurar o Correlation ID no objeto `req` cru do Express.
 * O middleware (correlation-id.middleware.ts) é quem escreve; esta classe
 * só lê. Compartilhada entre os dois arquivos para nunca divergir o nome.
 */
export const CORRELATION_ID_REQUEST_KEY = 'correlationId';

export type RequestWithCorrelationId = Request & { [CORRELATION_ID_REQUEST_KEY]?: string };

/**
 * CorrelationContext — AD-016.
 *
 * Deliberadamente SEPARADO de TenantContext: nasce antes da autenticação
 * (no middleware, para toda requisição, autenticada ou não) e existe para
 * depurar/correlacionar logs, não para autorização multi-tenant. Acoplá-lo a
 * TenantContext misturaria dois ciclos de vida e dois propósitos diferentes
 * (decisão explícita do usuário na aprovação da auditoria).
 *
 * Scope.REQUEST + injeção do REQUEST cru (token do próprio Nest) em vez de
 * um `set()` chamado por um Guard — o valor já foi definido pelo middleware
 * Express antes de qualquer Guard rodar, então basta ler do `req`.
 */
@Injectable({ scope: Scope.REQUEST })
export class CorrelationContext {
  constructor(@Inject(REQUEST) private readonly request: RequestWithCorrelationId) {}

  get correlationId(): string {
    return this.request[CORRELATION_ID_REQUEST_KEY] ?? 'sem-correlation-id';
  }
}
