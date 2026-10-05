import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AsaasWebhookGuard } from '@api/subscription/asaas-webhook.guard';

const TOKEN = 'token-de-webhook-de-teste-com-tamanho-razoavel';

function fakeContext(headerValue?: unknown): ExecutionContext {
  const request = { headers: headerValue === undefined ? {} : { 'asaas-access-token': headerValue } };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AsaasWebhookGuard — token próprio no header asaas-access-token', () => {
  const guard = new AsaasWebhookGuard();
  const originalToken = process.env.ASAAS_WEBHOOK_TOKEN;

  beforeEach(() => {
    process.env.ASAAS_WEBHOOK_TOKEN = TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.ASAAS_WEBHOOK_TOKEN;
    } else {
      process.env.ASAAS_WEBHOOK_TOKEN = originalToken;
    }
  });

  it('aceita o token correto', () => {
    expect(guard.canActivate(fakeContext(TOKEN))).toBe(true);
  });

  it.each([
    ['header ausente', undefined],
    ['token vazio', ''],
    ['token diferente, mesmo tamanho', `${TOKEN.slice(0, -1)}X`],
    ['prefixo do token correto', TOKEN.slice(0, 10)],
    ['token correto com sobra no fim', `${TOKEN}x`],
    ['header repetido (lista de valores)', [TOKEN, TOKEN]],
  ])('recusa com 401: %s', (_label, value) => {
    expect(() => guard.canActivate(fakeContext(value))).toThrow(UnauthorizedException);
  });

  it('sem ASAAS_WEBHOOK_TOKEN configurado: falha fechado (erro, nunca libera)', () => {
    delete process.env.ASAAS_WEBHOOK_TOKEN;
    expect(() => guard.canActivate(fakeContext(TOKEN))).toThrow('ASAAS_WEBHOOK_TOKEN não configurado');
  });
});
