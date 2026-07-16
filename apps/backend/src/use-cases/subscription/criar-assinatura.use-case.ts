import { Injectable, Inject, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClinicSubscription, PlanTier, BillingCycle } from '@domain/subscription/clinic-subscription.entity';
import {
  ClinicSubscriptionRepository,
  CLINIC_SUBSCRIPTION_REPOSITORY,
} from '@domain-services/subscription/clinic-subscription.repository';
import { PaymentProvider, PAYMENT_PROVIDER } from '@domain-services/subscription/payment-provider';

export interface CriarAssinaturaInput {
  tenantId: string;
  plan: PlanTier;
  billingCycle: BillingCycle;
  clinicName: string;
  clinicEmail: string;
  clinicCpfCnpj: string;
  billingType: 'CREDIT_CARD' | 'PIX';
}

/**
 * CriarAssinaturaUseCase — Módulo 17.
 *
 * Passo 1 do checkout "modelo Netflix" (ADR-0037): cria o cliente na Asaas,
 * cria a assinatura recorrente, salva o vínculo local. Se `billingType` for
 * CREDIT_CARD, o cartão em si é anexado por um segundo Caso de Uso
 * (AnexarCartaoUseCase).
 */
@Injectable()
export class CriarAssinaturaUseCase {
  constructor(
    @Inject(CLINIC_SUBSCRIPTION_REPOSITORY) private readonly repo: ClinicSubscriptionRepository,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
  ) {}

  async execute(input: CriarAssinaturaInput): Promise<ClinicSubscription> {
    const existing = await this.repo.findByTenantId(input.tenantId);
    if (existing && existing.status !== 'Cancelled') {
      throw new ConflictException('Esta clínica já possui uma assinatura ativa ou em trial.');
    }

    const subscription = ClinicSubscription.create({
      id: randomUUID(),
      tenantId: input.tenantId,
      plan: input.plan,
      billingCycle: input.billingCycle,
    });

    const { asaasCustomerId } = await this.paymentProvider.createCustomer({
      name: input.clinicName,
      email: input.clinicEmail,
      cpfCnpj: input.clinicCpfCnpj,
    });

    const { asaasSubscriptionId } = await this.paymentProvider.createSubscription({
      asaasCustomerId,
      billingType: input.billingType,
      value: subscription.amountPerCycle,
      cycle: input.billingCycle === 'monthly' ? 'MONTHLY' : 'YEARLY',
      description: `Assinatura Luxora — Plano ${input.plan}`,
      nextDueDate: new Date().toISOString().slice(0, 10),
    });

    subscription.linkToAsaas(asaasCustomerId, asaasSubscriptionId);
    await this.repo.save(subscription);
    subscription.pullDomainEvents();

    return subscription;
  }
}
