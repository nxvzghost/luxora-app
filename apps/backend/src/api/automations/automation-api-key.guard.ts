import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

/**
 * AutomationApiKeyGuard — Módulo 14.
 *
 * Endpoints de automação (chamados pelo n8n) usam uma API key própria,
 * não o fluxo de autenticação de usuário (Módulo 03) — reforça a
 * fronteira do ADR-0021: n8n é um executor externo autorizado, não um
 * usuário.
 */
@Injectable()
export class AutomationApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const providedKey = request.headers['x-automation-api-key'];
    const expectedKey = process.env.AUTOMATION_API_KEY;

    if (!expectedKey) {
      throw new Error('AUTOMATION_API_KEY não configurada no ambiente.');
    }
    if (providedKey !== expectedKey) {
      throw new UnauthorizedException('API key de automação inválida ou ausente.');
    }
    return true;
  }
}
