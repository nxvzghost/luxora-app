import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { CORRELATION_ID_REQUEST_KEY, type RequestWithCorrelationId } from './correlation-context';

const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * correlationIdMiddleware — AD-016.
 *
 * Middleware Express puro (app.use(), não um Guard/Interceptor do Nest):
 * precisa rodar antes de QUALQUER Guard, inclusive os de autenticação, para
 * que até respostas 401/403/429 tenham um Correlation ID rastreável. Guards
 * do Nest só executam depois do roteamento — tarde demais para esse
 * requisito.
 *
 * Aceita um X-Correlation-Id vindo do cliente/proxy (permite correlacionar
 * com o front-end ou um gateway de borda); gera um novo (UUID v4) quando
 * ausente. Sempre devolve o valor no header de resposta, para o cliente
 * também poder correlacionar do lado dele.
 */
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(CORRELATION_ID_HEADER);
  const correlationId = incoming && incoming.trim().length > 0 ? incoming.trim() : randomUUID();

  (req as RequestWithCorrelationId)[CORRELATION_ID_REQUEST_KEY] = correlationId;
  res.setHeader('X-Correlation-Id', correlationId);
  next();
}
