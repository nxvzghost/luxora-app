import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, LuxoraRole } from './roles.decorator';

/**
 * RolesGuard — bloqueia ação fora do perfil do usuário (critério de aceite
 * do Módulo 03, LUXORA/03 - ENGINEERING/00 - Roadmap/roadmap.md).
 *
 * DEVE rodar sempre DEPOIS de JwtAuthGuard na cadeia de guards — depende de
 * `request.userRole` já ter sido populado por ele. Se não houver @Roles()
 * no handler, o endpoint é liberado a qualquer usuário autenticado (o guard
 * só restringe quando explicitamente pedido).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<LuxoraRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const userRole: LuxoraRole | undefined = request.userRole;

    if (!userRole) {
      throw new ForbiddenException('Perfil de usuário não identificado — JwtAuthGuard deve rodar antes.');
    }

    // super_admin sempre passa — nunca bloqueado por RBAC de clínica
    if (userRole === 'super_admin') {
      return true;
    }

    if (!requiredRoles.includes(userRole)) {
      throw new ForbiddenException(`Ação restrita a: ${requiredRoles.join(', ')}.`);
    }

    return true;
  }
}
