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
        pastDueSince: subscription.pastDueSince,
        pendingPlan: subscription.pendingPlan as PlanTier | undefined,
        currentPeriodEnd: subscription.currentPeriodEnd,
        asaasCustomerId: subscription.asaasCustomerId,
        asaasSubscriptionId: subscription.asaasSubscriptionId,
      },
      update: {
        // BUG PRÉ-EXISTENTE CORRIGIDO NESTA SPRINT: `plan` nunca era
        // incluído aqui — Upgrade/Downgrade mudam `subscription.plan` em
        // memória, chamam `save()`, mas a mudança nunca chegava ao banco.
        // Achado ao implementar UpgradeAssinaturaUseCase (Priority 4), não
        // uma alteração de comportamento aprovada separadamente — apenas a
        // persistência já esperada por CEO-DEC-002.5/003.6 passando a
        // funcionar de fato.
        plan: subscription.plan as PlanTier,
        status: TO_DB_STATUS[subscription.status],
        // `?? null`, nunca `undefined`, nos campos abaixo: Prisma trata
        // `undefined` em update() como "não mexer no campo" — mas saída de
        // PastDue, aplicação de downgrade agendado, e avanço de ciclo
        // (confirmPayment) precisam explicitamente escrever o novo valor,
        // não preservar o anterior.
        pastDueSince: subscription.pastDueSince ?? null,
        pendingPlan: (subscription.pendingPlan as PlanTier | undefined) ?? null,
        // BUG PRÉ-EXISTENTE CORRIGIDO NESTA SPRINT: mesmo caso de `plan` —
        // currentPeriodEnd era lido em toDomain() mas nunca escrito aqui.
        // Achado ao implementar `confirmPayment()` (Priority 5-bloqueadora).
        currentPeriodEnd: subscription.currentPeriodEnd ?? null,
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
      pastDueSince: record.pastDueSince ?? undefined,
      pendingPlan: (record.pendingPlan as PlanTier | null) ?? undefined,
      asaasCustomerId: record.asaasCustomerId ?? undefined,
      asaasSubscriptionId: record.asaasSubscriptionId ?? undefined,
      currentPeriodEnd: record.currentPeriodEnd ?? undefined,
    });
  }
}
