import { Injectable } from '@nestjs/common';
import { RecurringBlock as PrismaRecurringBlock, PrismaClient } from '@prisma/client';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { RecurringBlock } from '@domain/availability/recurring-block.entity';
import { RecurringBlockRepository } from '@domain-services/availability/recurring-block.repository';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PrismaRecurringBlockRepository — deliberadamente NÃO usa PrismaService
 * (que lê o tenantId de TenantContext, implícito e request-scoped). A
 * interface (ver RecurringBlockRepository) exige tenantId explícito, então
 * este Repository abre a própria transação com RLS (`SET LOCAL
 * app.tenant_id`) a partir do parâmetro recebido — nunca de um contexto
 * ambiente. Mesma duplicação pequena e deliberada já documentada em
 * PrismaClinicHolidayRepository (PD-001 Fase 2, B3) — mesma razão.
 */
@Injectable()
export class PrismaRecurringBlockRepository implements RecurringBlockRepository {
  constructor(private readonly clientProvider: PrismaClientProvider) {}

  async save(block: RecurringBlock): Promise<void> {
    await this.withTenant(block.tenantId, (tx) =>
      tx.recurringBlock.upsert({
        where: { id: block.id },
        create: {
          id: block.id,
          tenantId: block.tenantId,
          patientId: block.patientId,
          therapistId: block.therapistId,
          firstOccurrence: block.firstOccurrence,
          intervalDays: block.intervalDays,
          modality: block.modality,
          renewalMode: block.renewalMode,
        },
        update: {
          patientId: block.patientId,
          therapistId: block.therapistId,
          firstOccurrence: block.firstOccurrence,
          intervalDays: block.intervalDays,
          modality: block.modality,
          renewalMode: block.renewalMode,
        },
      }),
    );
  }

  async findById(tenantId: string, blockId: string): Promise<RecurringBlock | null> {
    const record = await this.withTenant(tenantId, (tx) =>
      // tenantId no WHERE, não só no SET LOCAL da transação — defesa em
      // profundidade explícita, mesmo princípio de PrismaClinicHolidayRepository.
      tx.recurringBlock.findFirst({ where: { id: blockId, tenantId } }),
    );
    return record ? this.toDomain(record) : null;
  }

  async findByTenantAndTherapist(tenantId: string, therapistId: string): Promise<RecurringBlock[]> {
    const records = await this.withTenant(tenantId, (tx) =>
      // tenantId E therapistId no WHERE — mesma defesa em profundidade dos
      // demais métodos deste Repository.
      tx.recurringBlock.findMany({ where: { tenantId, therapistId }, orderBy: { firstOccurrence: 'asc' } }),
    );
    return records.map((r) => this.toDomain(r));
  }

  private async withTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    if (!UUID_REGEX.test(tenantId)) {
      throw new Error(`tenantId em formato inválido, recusando executar query: ${tenantId}`);
    }
    return this.clientProvider.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
      return fn(tx as PrismaClient);
    });
  }

  private toDomain(record: PrismaRecurringBlock): RecurringBlock {
    return RecurringBlock.reconstitute({
      id: record.id,
      tenantId: record.tenantId,
      patientId: record.patientId,
      therapistId: record.therapistId,
      firstOccurrence: record.firstOccurrence,
      intervalDays: record.intervalDays,
      modality: record.modality as 'presencial' | 'online',
      renewalMode: record.renewalMode as 'automatic' | 'manual',
    });
  }
}
