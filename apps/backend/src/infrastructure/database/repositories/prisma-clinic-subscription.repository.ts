import { Injectable } from '@nestjs/common';
import { ClinicSubscription as PrismaSub } from '@prisma/client';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { ClinicSubscription, PlanTier, BillingCycle, SubscriptionStatus } from '@domain/subscription/clinic-subscription.entity';
import { ClinicSubscriptionRepository } from '@domain-services/subscription/clinic-subscription.repository';

const TO_DB_STATUS: Record<SubscriptionStatus, PrismaSub['status']> = {
  Trialing: 'trialing',
  Active: 'active',
  PastDue: 'past_due',
  Cancelled: 'cancelled',
};
const TO_DOMAIN_STATUS: Record<PrismaSub['status'], SubscriptionStatus> = {
  trialing: 'Trialing',
  active: 'Active',
  past_due: 'PastDue',
  cancelled: 'Cancelled',
};

/**
 * PrismaClinicSubscriptionRepository — usa PrismaClientProvider (singleton,
 * Módulo 04) diretamente, não PrismaService.forTenant(). Motivo: o webhook
 * da Asaas (ProcessarWebhookAssinaturaUseCase) recebe apenas o
 * asaasSubscriptionId, sem JWT nenhum — não há TenantContext inicializado
 * nesse fluxo, mesma razão de design já aplicada a
 * WhatsAppMessageProvider (correção de isolamento do Módulo 11).
 */
@Injectable()
export class PrismaClinicSubscriptionRepository implements ClinicSubscriptionRepository {
  constructor(private readonly prismaClient: PrismaClientProvider) {}

  async findByTenantId(tenantId: string): Promise<ClinicSubscription | null> {
    const record = await this.prismaClient.clinicSubscription.findUnique({ where: { tenantId } });
    return record ? this.toDomain(record) : null;
  }

  async findByAsaasSubscriptionId(asaasSubscriptionId: string): Promise<ClinicSubscription | null> {
    const record = await this.prismaClient.clinicSubscription.findUnique({ where: { asaasSubscriptionId } });
    return record ? this.toDomain(record) : null;
  }

  async save(subscription: ClinicSubscription): Promise<void> {
    await this.prismaClient.clinicSubscription.upsert({
      where: { id: subscription.id },
      create: {
        id: subscription.id,
        tenantId: subscription.tenantId,
        plan: subscription.plan as PlanTier,
        billingCycle: subscription.billingCycle as BillingCycle,
        status: TO_DB_STATUS[subscription.status],
        asaasCustomerId: subscription.asaasCustomerId,
        asaasSubscriptionId: subscription.asaasSubscriptionId,
      },
      update: {
        status: TO_DB_STATUS[subscription.status],
        asaasCustomerId: subscription.asaasCustomerId,
        asaasSubscriptionId: subscription.asaasSubscriptionId,
      },
    });
  }

  private toDomain(record: PrismaSub): ClinicSubscription {
    return ClinicSubscription.reconstitute({
      id: record.id,
      tenantId: record.tenantId,
      plan: record.plan as PlanTier,
      billingCycle: record.billingCycle as BillingCycle,
      status: TO_DOMAIN_STATUS[record.status],
      asaasCustomerId: record.asaasCustomerId ?? undefined,
      asaasSubscriptionId: record.asaasSubscriptionId ?? undefined,
      currentPeriodEnd: record.currentPeriodEnd ?? undefined,
    });
  }
}
