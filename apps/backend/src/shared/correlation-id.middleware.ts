import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { CORRELATION_ID_REQUEST_KEY, type RequestWithCorrelationId } from './correlation-context';

const CORRELATION_ID_HEADER = 'x-correlation-id';
/** A-18: até 64 caracteres de um alfabeto seguro para log e cabeçalho (cobre UUID, ids de trace e ids de gateway). */
const ACCEPTED_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,64}$/;

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
 *
 * A-18 da auditoria (19/10/2026): o valor do cliente vai para os logs, para
 * as filas e para o cabeçalho da resposta, então só é aceito com até 64
 * caracteres de `[A-Za-z0-9._:-]`. Qualquer outra coisa (texto longo, espaço,
 * quebra de linha, acento, `]` que fecharia o marcador `[correlationId=…]`)
 * é trocada por um UUID gerado aqui — nunca é cortada nem "limpa".
 */
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(CORRELATION_ID_HEADER);
  const candidate = incoming?.trim();
  const correlationId = candidate && ACCEPTED_CORRELATION_ID.test(candidate) ? candidate : randomUUID();

  (req as RequestWithCorrelationId)[CORRELATION_ID_REQUEST_KEY] = correlationId;
  res.setHeader('X-Correlation-Id', correlationId);
  next();
}
