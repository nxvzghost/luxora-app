import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { TenantContext } from '@shared/tenant-context';
import {
  ClinicSubscriptionRepository,
  CLINIC_SUBSCRIPTION_REPOSITORY,
} from '@domain-services/subscription/clinic-subscription.repository';
import { PLAN_BENEFITS } from '@domain-services/subscription/plan-benefits';

/**
 * GerarApiKeyUseCase — PD-003, Módulo 17.
 *
 * Gera (ou regenera, invalidando a anterior — upsert, 1 chave ativa por
 * vez) a chave de API do Tenant. Retorna o segredo em texto puro — única
 * vez que ele existe fora do hash, nunca mais recuperável depois (mesmo
 * padrão de Personal Access Token do GitHub).
 *
 * Hash é SHA-256, não bcrypt (ver TenantApiKey em schema.prisma para a
 * justificativa completa) — a chave já é alta entropia gerada
 * aleatoriamente, não uma senha escolhida por humano.
 */
@Injectable()
export class GerarApiKeyUseCase {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLINIC_SUBSCRIPTION_REPOSITORY) private readonly subscriptionRepo: ClinicSubscriptionRepository,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(): Promise<{ apiKey: string }> {
    const subscription = await this.subscriptionRepo.findByTenantId(this.tenantContext.tenantId);
    // Optional chaining, não getPlanBenefits(): plano sem benefícios
    // configurados ('individual'/'completo', Priority 5) nega acesso, não
    // lança erro.
    const hasApiAccess = subscription ? (PLAN_BENEFITS[subscription.plan]?.externalApiAccess ?? false) : false;
    if (!hasApiAccess) {
      throw new ConflictException({
        code: 'API_ACCESS_NOT_INCLUDED',
        message: 'O plano atual não inclui acesso à API. Faça upgrade para Business ou Enterprise.',
        category: 'business_rule',
      });
    }

    const secret = randomBytes(32).toString('hex');
    const hashedKey = createHash('sha256').update(secret).digest('hex');

    await this.prisma.forTenant((tx) =>
      tx.tenantApiKey.upsert({
        where: { tenantId: this.tenantContext.tenantId },
        create: { tenantId: this.tenantContext.tenantId, hashedKey },
        update: { hashedKey, lastUsedAt: null },
      }),
    );

    return { apiKey: secret };
  }
}
