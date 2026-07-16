import { Injectable, ConflictException } from '@nestjs/common';
import { Payment as PrismaPayment, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { Payment, PaymentState } from '@domain/payment/payment.entity';
import { PaymentRepository } from '@domain-services/financial/payment.repository';

const TO_DB: Record<PaymentState, PaymentStatus> = {
  Recebido: 'recebido',
  EmConferencia: 'em_conferencia',
  Confirmado: 'confirmado',
  Divergente: 'divergente',
  Estornado: 'estornado',
};
const TO_DOMAIN: Record<PaymentStatus, PaymentState> = Object.fromEntries(
  Object.entries(TO_DB).map(([k, v]) => [v, k]),
) as Record<PaymentStatus, PaymentState>;

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

@Injectable()
export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Payment | null> {
    const record = await this.prisma.forTenant((tx) => tx.payment.findUnique({ where: { id } }));
    return record ? this.toDomain(record) : null;
  }

  async findByIdempotencyKey(key: string): Promise<Payment | null> {
    const record = await this.prisma.forTenant((tx) => tx.payment.findUnique({ where: { idempotencyKey: key } }));
    return record ? this.toDomain(record) : null;
  }

  async save(payment: Payment): Promise<void> {
    try {
      await this.prisma.forTenant((tx) =>
        tx.payment.upsert({
          where: { id: payment.id },
          create: {
            id: payment.id,
            tenantId: payment.tenantId,
            billingId: payment.billingId,
            amount: payment.amount as unknown as Prisma.Decimal,
            method: 'pix',
            status: TO_DB[payment.state],
            idempotencyKey: payment.idempotencyKey,
          },
          update: { status: TO_DB[payment.state] },
        }),
      );
    } catch (err) {
      // idempotencyKey é @unique no banco (Módulo 01) — segunda camada de
      // defesa contra pagamento duplicado (RNF-008, Teste Crítico #8),
      // além da checagem explícita já feita no Use Case via
      // findByIdempotencyKey antes de chamar save().
      if ((err as Prisma.PrismaClientKnownRequestError)?.code === UNIQUE_CONSTRAINT_VIOLATION) {
        throw new ConflictException({
          code: 'DUPLICATE_PAYMENT',
          message: 'Pagamento com esta idempotency key já foi registrado.',
          category: 'business_rule',
        });
      }
      throw err;
    }
  }

  private toDomain(record: PrismaPayment): Payment {
    return Payment.reconstitute({
      id: record.id,
      tenantId: record.tenantId,
      billingId: record.billingId,
      amount: Number(record.amount),
      method: record.method,
      idempotencyKey: record.idempotencyKey,
      state: TO_DOMAIN[record.status],
    });
  }
}
