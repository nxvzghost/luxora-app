import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TenantContext } from '@shared/tenant-context';

interface LuxoraJwtPayload {
  sub: string; // userId
  tenantId: string;
  role: 'admin' | 'therapist' | 'super_admin';
}

/**
 * JwtAuthGuard — único ponto de entrada do tenantId no sistema.
 *
 * Fonte de verdade: docs/02-Arquitetura/06-Autenticacao.md, docs/04-API/00-Principios-da-API.md.
 *
 * Regra: tenantId e userId SEMPRE vêm do payload do JWT validado, nunca de
 * header custom, query string ou body — isso é o que impede um usuário
 * autenticado no Tenant A de acessar dado do Tenant B trocando um parâmetro.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly tenantContext: TenantContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token ausente.');
    }

    const token = authHeader.slice('Bearer '.length);

    let payload: LuxoraJwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<LuxoraJwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Token inválido ou expirado.');
    }

    // Único lugar do sistema onde tenantId é atribuído — nunca em outro ponto do código.
    this.tenantContext.set(payload.tenantId, payload.sub);
    request.userRole = payload.role;

    return true;
  }
}
