import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

/**
 * MetricsAccessGuard — AD-016.
 *
 * GET /metrics expõe contagens operacionais e de negócio (ver
 * MetricsController) — nunca pode ser uma rota pública. Mesmo padrão de
 * AutomationApiKeyGuard: token estático comparado por header, sem
 * dependência de autenticação de usuário (quem consome isto é um scraper
 * Prometheus, não uma pessoa logada).
 */
@Injectable()
export class MetricsAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const providedToken = request.headers['x-metrics-token'];
    const expectedToken = process.env.METRICS_ACCESS_TOKEN;

    if (!expectedToken) {
      throw new Error('METRICS_ACCESS_TOKEN não configurada no ambiente.');
    }
    if (providedToken !== expectedToken) {
      throw new UnauthorizedException('Token de acesso a métricas inválido ou ausente.');
    }
    return true;
  }
}
