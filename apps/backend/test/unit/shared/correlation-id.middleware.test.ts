import { describe, it, expect, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { correlationIdMiddleware } from '@shared/correlation-id.middleware';
import { CORRELATION_ID_REQUEST_KEY } from '@shared/correlation-context';

function mockReqRes(incomingHeader?: string) {
  const req = {
    header: vi.fn().mockReturnValue(incomingHeader),
  } as unknown as Request;
  const res = {
    setHeader: vi.fn(),
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
}

describe('correlationIdMiddleware (AD-016)', () => {
  it('gera um novo UUID quando o cliente não envia X-Correlation-Id', () => {
    const { req, res, next } = mockReqRes(undefined);
    correlationIdMiddleware(req, res, next);

    const attached = (req as unknown as Record<string, unknown>)[CORRELATION_ID_REQUEST_KEY] as string;
    expect(typeof attached).toBe('string');
    expect(attached.length).toBeGreaterThan(0);
    expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-Id', attached);
    expect(next).toHaveBeenCalledOnce();
  });

  it('reaproveita o X-Correlation-Id enviado pelo cliente/proxy, em vez de gerar um novo', () => {
    const { req, res, next } = mockReqRes('id-vindo-do-cliente-123');
    correlationIdMiddleware(req, res, next);

    expect((req as unknown as Record<string, unknown>)[CORRELATION_ID_REQUEST_KEY]).toBe('id-vindo-do-cliente-123');
    expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-Id', 'id-vindo-do-cliente-123');
    expect(next).toHaveBeenCalledOnce();
  });

  it('ignora um header vazio/só espaços e gera um novo (nunca propaga string vazia)', () => {
    const { req, res, next } = mockReqRes('   ');
    correlationIdMiddleware(req, res, next);

    const attached = (req as unknown as Record<string, unknown>)[CORRELATION_ID_REQUEST_KEY] as string;
    expect(attached.trim().length).toBeGreaterThan(0);
    expect(attached).not.toBe('   ');
  });
});
