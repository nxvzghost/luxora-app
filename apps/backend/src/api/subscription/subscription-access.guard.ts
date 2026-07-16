import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SKIP_SUBSCRIPTION_CHECK } from './skip-subscription-check.decorator';
import {
  ClinicSubscriptionRepository,
  CLINIC_SUBSCRIPTION_REPOSITORY,
} from '@domain-services/subscription/clinic-subscription.repository';
import { TenantContext } from '@shared/tenant-context';

/**
 * SubscriptionAccessGuard — Módulo 17. O GATE DE ACESSO que faltava desde
 * a implementação original (ADR-0039) — sem isso, uma assinatura
 * PastDue/Cancelled não bloqueava nada de verdade.
 *
 * DEVE rodar sempre DEPOIS de JwtAuthGuard na cadeia (depende de
 * TenantContext já inicializado) — mesma ordem já usada por RolesGuard.
 *
 * DECISÃO DE ESCOPO: sem meio-termo por enquanto — bloqueia tudo exceto
 * rotas com @SkipSubscriptionCheck() (login, a própria tela de assinatura,
 * webhook). Se precisar de acesso parcial mais granular (ex: PastDue só
 * consegue ver dado, não criar) no futuro, é dívida a resolver depois,
 * não implementada agora.
 */
@Injectable()
export class SubscriptionAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(CLINIC_SUBSCRIPTION_REPOSITORY) private readonly repo: ClinicSubscriptionRepository,
    private readonly tenantContext: TenantContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_SUBSCRIPTION_CHECK, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    // Se TenantContext não foi inicializado (rota pública, sem JwtAuthGuard
    // antes), este guard não tem o que checar — deixa passar. "Rota exige
    // login" é responsabilidade do JwtAuthGuard, não desta.
    if (!this.tenantContext.isInitialized) return true;

    const subscription = await this.repo.findByTenantId(this.tenantContext.tenantId);

    if (!subscription || !subscription.hasActiveAccess) {
      throw new ForbiddenException({
        code: 'SUBSCRIPTION_INACTIVE',
        message: 'Assinatura da clínica inativa ou pendente. Regularize o pagamento para continuar.',
        category: 'authorization',
      });
    }

    return true;
  }
}
