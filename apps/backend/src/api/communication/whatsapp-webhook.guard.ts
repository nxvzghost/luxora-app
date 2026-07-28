import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * WhatsAppWebhookGuard — ADR-0053 §2.2.
 *
 * Estruturalmente diferente do único precedente existente (AsaasWebhookGuard,
 * comparação de string simples): a Meta assina o CORPO BRUTO de cada POST
 * com HMAC-SHA256 (header `X-Hub-Signature-256`), usando o App Secret —
 * único por App da Meta, nunca por Tenant. Exige `request.rawBody` (Buffer),
 * disponível globalmente via `NestFactory.create(AppModule, { rawBody: true })`
 * em main.ts (e o equivalente em test/critical/support/bootstrap-app.ts).
 *
 * Comparação em tempo constante (timingSafeEqual) — nunca `===` numa
 * verificação de assinatura, para não vazar informação por timing.
 *
 * Resolução de Tenant NÃO acontece aqui — um único POST pode conter
 * mensagens de vários Tenants diferentes (vários phoneNumberId no mesmo
 * payload da Meta); a resolução é feita por mensagem, dentro de
 * ReceberMensagemWhatsAppUseCase (ver ADR-0053 §2.3).
 */
@Injectable()
export class WhatsAppWebhookGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const signatureHeader: string | undefined = request.headers['x-hub-signature-256'];
    const appSecret = process.env.WHATSAPP_APP_SECRET;

    if (!appSecret) {
      throw new Error('WHATSAPP_APP_SECRET não configurado no ambiente.');
    }
    if (!signatureHeader) {
      throw new UnauthorizedException('Assinatura do webhook do WhatsApp ausente.');
    }

    const rawBody: Buffer | undefined = request.rawBody;
    if (!rawBody) {
      throw new Error(
        'Corpo bruto da requisição indisponível — verifique NestFactory.create(AppModule, { rawBody: true }).',
      );
    }

    const expectedSignature = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
    const provided = Buffer.from(signatureHeader);
    const expected = Buffer.from(expectedSignature);

    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new UnauthorizedException('Assinatura do webhook do WhatsApp inválida.');
    }

    return true;
  }
}
