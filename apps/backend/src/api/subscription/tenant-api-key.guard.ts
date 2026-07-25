import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { TenantContext } from '@shared/tenant-context';
import {
  ClinicSubscriptionRepository,
  CLINIC_SUBSCRIPTION_REPOSITORY,
} from '@domain-services/subscription/clinic-subscription.repository';
import { PLAN_BENEFITS } from '@domain-services/subscription/plan-benefits';

/**
 * TenantApiKeyGuard — PD-003, Módulo 17.
 *
 * Segundo (e único outro) ponto de entrada autorizado de tenantId no
 * sistema, ao lado de JwtAuthGuard — ver comentário lá. Autentica
 * requisições de integrações externas via chave de API por Tenant
 * (Business/Enterprise), nunca login de usuário — não existe um `userId`
 * real aqui, `tenantContext.set(tenantId, null)` reflete isso.
 *
 * Reaproveita PrismaService.forAuthLookup() — mesmo bypass de RLS já usado
 * pelo login por email (ADR-0024) — para localizar o Tenant dono da chave
 * sem conhecer o tenantId de antemão. Ver prisma/rls/enable-rls.sql,
 * policy `api_key_lookup_by_hash`.
 */
@Injectable()
export class TenantApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLINIC_SUBSCRIPTION_REPOSITORY) private readonly subscriptionRepo: ClinicSubscriptionRepository,
    private readonly tenantContext: TenantContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const providedKey: string | undefined = request.headers['x-api-key'];
    if (!providedKey) {
      throw new UnauthorizedException('X-API-Key ausente.');
    }

    const hashedKey = createHash('sha256').update(providedKey).digest('hex');
    const record = await this.prisma.forAuthLookup((tx) => tx.tenantApiKey.findUnique({ where: { hashedKey } }));

    if (!record) {
      throw new UnauthorizedException('API key inválida.');
    }

    // Confere o plano de novo, na hora — se o Tenant foi rebaixado para
    // Professional depois de gerar a chave, ela para de funcionar sem
    // precisar de revogação manual (mesmo padrão do SubscriptionAccessGuard,
    // que também não confia em estado cacheado).
    const subscription = await this.subscriptionRepo.findByTenantId(record.tenantId);
    // Optional chaining, não getPlanBenefits(): este é um gate de acesso —
    // plano sem benefícios configurados ('individual'/'completo', Priority
    // 5) deve negar silenciosamente, nunca lançar erro 500.
    const hasApiAccess = subscription ? (PLAN_BENEFITS[subscription.plan]?.externalApiAccess ?? false) : false;
    if (!hasApiAccess) {
      throw new ForbiddenException({
        code: 'API_ACCESS_NOT_INCLUDED',
        message: 'O plano atual não inclui acesso à API.',
        category: 'authorization',
      });
    }

    this.tenantContext.set(record.tenantId, null);

    return true;
  }
}
