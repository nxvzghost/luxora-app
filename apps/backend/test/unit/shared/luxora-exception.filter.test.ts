import { describe, it, expect, vi } from 'vitest';
import { ArgumentsHost, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { LuxoraExceptionFilter } from '@shared/luxora-exception.filter';

function mockHost() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
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

  it('todo erro inclui timestamp em formato ISO', () => {
    const { host, json } = mockHost();
    filter.catch(new NotFoundException(), host);
    const call = json.mock.calls[0][0];
    expect(() => new Date(call.error.timestamp).toISOString()).not.toThrow();
  });
});
