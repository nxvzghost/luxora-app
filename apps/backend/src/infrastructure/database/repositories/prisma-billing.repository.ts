import { ConflictException, Injectable } from '@nestjs/common';
import { Billing as PrismaBilling, BillingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { Billing, BillingState } from '@domain/billing/billing.entity';
import { BillingRepository } from '@domain-services/financial/billing.repository';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

/**
 * Mapeamento de case entre o Domain (PascalCase: 'Criada') e o banco
 * (lowercase: 'criada') — dívida registrada no ADR-0028, resolvida aqui.
 * Sem isso, toda gravação falharia com erro de enum inválido do Prisma.
 */
const TO_DB: Record<BillingState, BillingStatus> = {
  Criada: 'criada',
  Enviada: 'enviada',
  Visualizada: 'visualizada',
  Pendente: 'pendente',
  Atrasada: 'atrasada',
  Negociada: 'negociada',
  Escalada: 'escalada',
  Quitada: 'quitada',
  Cancelada: 'cancelada',
};
const TO_DOMAIN: Record<BillingStatus, BillingState> = Object.fromEntries(
  Object.entries(TO_DB).map(([k, v]) => [v, k]),
) as Record<BillingStatus, BillingState>;

@Injectable()
export class PrismaBillingRepository implements BillingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Billing | null> {
    const record = await this.prisma.forTenant((tx) => tx.billing.findUnique({ where: { id } }));
    return record ? this.toDomain(record) : null;
  }

  async findAllByTenant(params?: { cursor?: string; limit?: number }): Promise<Billing[]> {
    const limit = params?.limit ?? 20;
    const records = await this.prisma.forTenant((tx) =>
      tx.billing.findMany({
        take: limit,
        ...(params?.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
        orderBy: { createdAt: 'desc' },
      }),
    );
    return records.map((r) => this.toDomain(r));
  }

  async save(billing: Billing): Promise<void> {
    await this.prisma.forTenant((tx) =>
      tx.billing.upsert({
        where: { id: billing.id },
        create: {
          id: billing.id,
          tenantId: billing.tenantId,
          patientId: billing.patientId,
          amount: billing.amount as unknown as Prisma.Decimal,
          dueDate: billing.dueDate,
          status: TO_DB[billing.state],
        },
        update: { status: TO_DB[billing.state] },
      }),
    );
  }

  async linkSessions(billingId: string, sessionIds: string[]): Promise<void> {
    try {
      await this.prisma.forTenant(async (tx) => {
        const billing = await tx.billing.findUniqueOrThrow({ where: { id: billingId } });
        await tx.billingSession.createMany({
          data: sessionIds.map((sessionId) => ({
            tenantId: billing.tenantId,
            billingId,
            sessionId,
          })),
        });
        // UNIQUE(session_id) na tabela billing_session (Módulo 01) já garante
        // que uma sessão nunca entra em duas cobranças abertas ao mesmo tempo
        // — createMany lança erro de constraint se isso for tentado, nunca
        // depende só desta checagem em código.
      });
    } catch (err) {
      // BUG REAL ENCONTRADO E CORRIGIDO: sem este catch, a violação da
      // constraint UNIQUE(session_id) (Teste Crítico #7) vazava como
      // INTERNAL_SERVER_ERROR genérico em vez de um erro de regra de
      // negócio claro — mesma categoria de erro que SESSION_CONFLICT já
      // trata para agendamento duplicado (prisma-appointment.repository.ts),
      // aplicada aqui pela primeira vez para cobrança.
      if ((err as Prisma.PrismaClientKnownRequestError)?.code === UNIQUE_CONSTRAINT_VIOLATION) {
        throw new ConflictException({
          code: 'SESSION_ALREADY_BILLED',
          message: 'Uma ou mais sessões já estão vinculadas a outra cobrança em aberto.',
          category: 'business_rule',
        });
      }
      throw err;
    }
  }

  async findOverdueByTenant(): Promise<Billing[]> {
    const records = await this.prisma.forTenant((tx) =>
      tx.billing.findMany({ where: { status: 'atrasada' }, orderBy: { dueDate: 'asc' } }),
    );
    return records.map((r) => this.toDomain(r));
  }

  async countLinkedSessions(billingId: string): Promise<number> {
    return this.prisma.forTenant((tx) => tx.billingSession.count({ where: { billingId } }));
  }

  private toDomain(record: PrismaBilling): Billing {
    return Billing.reconstitute({
      id: record.id,
      tenantId: record.tenantId,
      patientId: record.patientId,
      amount: Number(record.amount),
      dueDate: record.dueDate,
      state: TO_DOMAIN[record.status],
    });
  }
}
