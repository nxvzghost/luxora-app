import { describe, it, expect, vi } from 'vitest';
import { ArgumentsHost, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { LuxoraExceptionFilter } from '@shared/luxora-exception.filter';
import { CORRELATION_ID_REQUEST_KEY } from '@shared/correlation-context';

function mockHost(correlationId?: string) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ [CORRELATION_ID_REQUEST_KEY]: correlationId }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('LuxoraExceptionFilter', () => {
  const filter = new LuxoraExceptionFilter();

  it('formata NotFoundException no formato oficial (category: not_found)', () => {
    const { host, status, json } = mockHost();
    filter.catch(new NotFoundException('Paciente não encontrado.'), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'NOT_FOUND', category: 'not_found', message: 'Paciente não encontrado.' }),
      }),
    );
  });

  it('preserva code/category customizados já passados (ex: SESSION_CONFLICT)', () => {
    const { host, json } = mockHost();
    filter.catch(new ConflictException({ code: 'SESSION_CONFLICT', message: 'Horário já reservado.', category: 'business_rule' }), host);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'SESSION_CONFLICT', category: 'business_rule' }) }),
    );
  });

  it('achata array de mensagens do ValidationPipe em uma única string', () => {
    const { host, json } = mockHost();
    filter.catch(new BadRequestException({ message: ['name deve ter ao menos 2 caracteres', 'phone é obrigatório'] }), host);
    const call = json.mock.calls[0][0];
    expect(call.error.message).toBe('name deve ter ao menos 2 caracteres; phone é obrigatório');
    expect(call.error.category).toBe('validation');
  });

  it('nunca vaza stack trace para erro não-HTTP — retorna mensagem genérica com category system', () => {
    const { host, status, json } = mockHost();
    filter.catch(new Error('detalhe interno sensível do banco'), host);
    expect(status).toHaveBeenCalledWith(500);
    const call = json.mock.calls[0][0];
    expect(call.error.message).not.toContain('detalhe interno sensível');
    expect(call.error.category).toBe('system');
  });

  // AD-006 — ThrottlerException (@nestjs/throttler) precisa sair no formato
  // oficial da API, não no formato padrão do Nest (statusCode/message/error).
  it('formata ThrottlerException no formato oficial (status 429, code TOO_MANY_REQUESTS, category rate_limit)', () => {
    const { host, status, json } = mockHost();
    filter.catch(new ThrottlerException(), host);
    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'TOO_MANY_REQUESTS', category: 'rate_limit' }) }),
    );
  });

  it('todo erro inclui timestamp em formato ISO', () => {
    const { host, json } = mockHost();
    filter.catch(new NotFoundException(), host);
    const call = json.mock.calls[0][0];
    expect(() => new Date(call.error.timestamp).toISOString()).not.toThrow();
  });

  // AD-016 — o correlationId já preenchido no req pelo correlationIdMiddleware
  // (main.ts) precisa aparecer no corpo de erro, para o cliente/observabilidade
  // conseguir correlacionar a falha com o resto dos logs daquela requisição.
  it('inclui o correlationId do request no corpo de erro, quando presente', () => {
    const { host, json } = mockHost('11111111-1111-1111-1111-111111111111');
    filter.catch(new NotFoundException(), host);
    const call = json.mock.calls[0][0];
    expect(call.error.correlationId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('correlationId é null no corpo de erro quando o request não possui um (nunca lança)', () => {
    const { host, json } = mockHost(undefined);
    filter.catch(new NotFoundException(), host);
    const call = json.mock.calls[0][0];
    expect(call.error.correlationId).toBeNull();
  });
});
