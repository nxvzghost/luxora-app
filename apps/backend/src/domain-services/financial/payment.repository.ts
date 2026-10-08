import { Payment, PaymentState } from '@domain/payment/payment.entity';

export interface PaymentRepository {
  findById(id: string): Promise<Payment | null>;
  findByIdempotencyKey(key: string): Promise<Payment | null>;
  /** Tarefa 05 — o pagamento de uma cobrança (no máximo um: `billing_id` é único). */
  findByBillingId(billingId: string): Promise<Payment | null>;
  /** Tarefa 05 — estado do pagamento de cada cobrança informada, numa consulta só. Cobrança sem pagamento fica fora do mapa. */
  findStatesByBillingIds(billingIds: string[]): Promise<Map<string, PaymentState>>;
  save(payment: Payment): Promise<void>;
}

export const PAYMENT_REPOSITORY = Symbol('PAYMENT_REPOSITORY');
