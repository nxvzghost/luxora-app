import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { ClinicSubscription } from '@domain/subscription/clinic-subscription.entity';
import {
  ClinicSubscriptionRepository,
  CLINIC_SUBSCRIPTION_REPOSITORY,
} from '@domain-services/subscription/clinic-subscription.repository';
import { PaymentProvider, PAYMENT_PROVIDER } from '@domain-services/subscription/payment-provider';

export interface AnexarCartaoInput {
  tenantId: string;
  holderName: string;
  number: string;
  expiryMonth: string;
  expiryYear: string;
  ccv: string;
  holderEmail: string;
  holderCpfCnpj: string;
  remoteIp: string;
}

/**
 * AnexarCartaoUseCase — passo 2 do checkout (só quando billingType=CREDIT_CARD).
 * O número do cartão passa por aqui em memória, na mesma requisição, e
 * segue direto para a Asaas via PaymentProvider — nunca é persistido em
 * nenhuma variável de longa duração, log, ou tabela do banco.
 */
@Injectable()
export class AnexarCartaoUseCase {
  constructor(
    @Inject(CLINIC_SUBSCRIPTION_REPOSITORY) private readonly repo: ClinicSubscriptionRepository,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
  ) {}

  async execute(input: AnexarCartaoInput): Promise<void> {
    const subscription = await this.repo.findByTenantId(input.tenantId);
    if (!subscription) throw new NotFoundException('Assinatura não encontrada.');
    if (!subscription.asaasSubscriptionId) {
      throw new BadRequestException('Assinatura ainda não foi vinculada à Asaas.');
    }

    await this.paymentProvider.attachCreditCard({
      asaasSubscriptionId: subscription.asaasSubscriptionId,
      holderName: input.holderName,
      number: input.number,
      expiryMonth: input.expiryMonth,
      expiryYear: input.expiryYear,
      ccv: input.ccv,
      holderEmail: input.holderEmail,
      holderCpfCnpj: input.holderCpfCnpj,
      remoteIp: input.remoteIp,
    });
  }
}

@Injectable()
export class ConsultarAssinaturaUseCase {
  constructor(@Inject(CLINIC_SUBSCRIPTION_REPOSITORY) private readonly repo: ClinicSubscriptionRepository) {}

  async execute(tenantId: string): Promise<ClinicSubscription> {
    const subscription = await this.repo.findByTenantId(tenantId);
    if (!subscription) throw new NotFoundException('Assinatura não encontrada.');
    return subscription;
  }
}
