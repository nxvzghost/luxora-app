import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { WhatsAppWebhookGuard } from '@api/communication/whatsapp-webhook.guard';

const APP_SECRET = 'test-app-secret';

function fakeContext(rawBody: Buffer, signatureHeader?: string): ExecutionContext {
  const request = {
    rawBody,
    headers: signatureHeader ? { 'x-hub-signature-256': signatureHeader } : {},
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function sign(rawBody: Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

describe('WhatsAppWebhookGuard — ADR-0053 §2.2 (HMAC-SHA256 sobre o corpo bruto)', () => {
  const guard = new WhatsAppWebhookGuard();
  const originalSecret = process.env.WHATSAPP_APP_SECRET;

  beforeEach(() => {
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  });

  afterEach(() => {
    process.env.WHATSAPP_APP_SECRET = originalSecret;
  });

  it('aceita uma assinatura válida, calculada sobre os bytes exatos do corpo', () => {
    const rawBody = Buffer.from(JSON.stringify({ entry: [] }));
    const context = fakeContext(rawBody, sign(rawBody, APP_SECRET));
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejeita quando a assinatura não bate com o corpo (payload adulterado)', () => {
    const rawBody = Buffer.from(JSON.stringify({ entry: [] }));
    const wrongSignature = sign(Buffer.from(JSON.stringify({ entry: ['adulterado'] })), APP_SECRET);
    const context = fakeContext(rawBody, wrongSignature);
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejeita quando a assinatura foi calculada com um secret diferente', () => {
    const rawBody = Buffer.from(JSON.stringify({ entry: [] }));
    const context = fakeContext(rawBody, sign(rawBody, 'secret-errado'));
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejeita quando o header de assinatura está ausente', () => {
    const rawBody = Buffer.from(JSON.stringify({ entry: [] }));
    const context = fakeContext(rawBody, undefined);
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('lança erro de configuração quando WHATSAPP_APP_SECRET não está definido', () => {
    delete process.env.WHATSAPP_APP_SECRET;
    const rawBody = Buffer.from('{}');
    const context = fakeContext(rawBody, 'sha256=qualquercoisa');
    expect(() => guard.canActivate(context)).toThrow(/WHATSAPP_APP_SECRET/);
  });

  it('lança erro claro quando request.rawBody não está disponível (rawBody:true ausente no bootstrap)', () => {
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { 'x-hub-signature-256': 'sha256=x' } }),
      }),
    } as unknown as ExecutionContext;
    expect(() => guard.canActivate(context)).toThrow(/rawBody/);
  });
});
