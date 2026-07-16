/**
 * PaymentProvider — porta. Módulo 17 (ADR-0037), abstração já prevista
 * desde o ADR-0003 original (citava Mercado Pago/Stripe/Asaas como
 * candidatos). Mesmo padrão arquitetural de MessageProvider (M11) e
 * IAIProvider (M12) — nenhum Caso de Uso chama a Asaas diretamente.
 */
export interface CreateCustomerInput {
  name: string;
  email: string;
  cpfCnpj: string;
}

export interface CreateSubscriptionInput {
  asaasCustomerId: string;
  billingType: 'CREDIT_CARD' | 'PIX';
  value: number;
  cycle: 'MONTHLY' | 'YEARLY';
  description: string;
  nextDueDate: string;
}

export interface AttachCreditCardInput {
  asaasSubscriptionId: string;
  holderName: string;
  number: string;
  expiryMonth: string;
  expiryYear: string;
  ccv: string;
  holderEmail: string;
  holderCpfCnpj: string;
  remoteIp: string;
}

export interface PaymentProvider {
  createCustomer(input: CreateCustomerInput): Promise<{ asaasCustomerId: string }>;
  createSubscription(input: CreateSubscriptionInput): Promise<{ asaasSubscriptionId: string }>;
  /**
   * Recebe o cartão diretamente e repassa à Asaas na mesma chamada — nunca
   * persiste número de cartão em nenhum lugar da Luxora (nem log, nem
   * banco), mesmo princípio já registrado desde a Diretriz Oficial.
   */
  attachCreditCard(input: AttachCreditCardInput): Promise<void>;
  cancelSubscription(asaasSubscriptionId: string): Promise<void>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
