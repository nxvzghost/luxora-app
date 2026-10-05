import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

/**
 * AsaasWebhookGuard — Módulo 17.
 *
 * A própria documentação da Asaas é explícita: "Nunca utilize a API Key do
 * Asaas como token de autenticação do Webhook". O token aqui é um valor
 * próprio, gerado por nós e configurado no painel da Asaas (Integrações >
 * Webhooks), enviado de volta no header `asaas-access-token` em toda
 * notificação — nunca a mesma chave usada para chamar a API deles.
 *
 * Comparação em tempo constante (timingSafeEqual), como já faz
 * WhatsAppWebhookGuard — nunca `===`/`!==` num segredo.
 */
@Injectable()
export class AsaasWebhookGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const providedToken = request.headers['asaas-access-token'];
    const expectedToken = process.env.ASAAS_WEBHOOK_TOKEN;

    if (!expectedToken) {
      throw new Error('ASAAS_WEBHOOK_TOKEN não configurado no ambiente.');
    }
    const provided = Buffer.from(typeof providedToken === 'string' ? providedToken : '');
    const expected = Buffer.from(expectedToken);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new UnauthorizedException('Token de webhook Asaas inválido ou ausente.');
    }
    return true;
  }
}
