import { Injectable } from '@nestjs/common';
import { ClinicHoliday as PrismaClinicHoliday, PrismaClient } from '@prisma/client';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { ClinicHoliday } from '@domain/availability/clinic-holiday.entity';
import { ClinicHolidayRepository } from '@domain-services/availability/clinic-holiday.repository';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PrismaClinicHolidayRepository — deliberadamente NÃO usa PrismaService
 * (que lê o tenantId de TenantContext, implícito e request-scoped). A
 * interface (ver ClinicHolidayRepository) exige tenantId explícito, então
 * este Repository abre a própria transação com RLS (`SET LOCAL
 * app.tenant_id`) a partir do parâmetro recebido — nunca de um contexto
 * ambiente. Isso duplica ~3 linhas de validação/transação que já existem
 * em PrismaService.forTenant() (a mesma validação de formato UUID antes de
 * interpolar em SQL cru, pela mesma razão: `$executeRawUnsafe` não
 * parametriza, então o valor precisa ser validado antes, não escapado
 * depois). Duplicação pequena e deliberada — extrair um helper comum só
 * faz sentido quando um segundo repositório "job-safe" precisar do mesmo
 * padrão.
 */
@Injectable()
export class PrismaClinicHolidayRepository implements ClinicHolidayRepository {
  constructor(private readonly clientProvider: PrismaClientProvider) {}

  async findByTenantAndRange(tenantId: string, from: Date, to: Date): Promise<ClinicHoliday[]> {
    const records = await this.withTenant(tenantId, (tx) =>
      tx.clinicHoliday.findMany({
        where: {
          tenantId,
          // Mesma semântica de intervalo de ClinicHoliday.overlaps() — ver
          // nota no contrato da interface. Não é a regra de negócio, é a
          // tradução dela para SQL.
          fromDate: { lt: to },
          toDate: { gt: from },
        },
        orderBy: { fromDate: 'asc' },
      }),
    );
    return records.map((r) => this.toDomain(r));
  }

  async save(holiday: ClinicHoliday): Promise<void> {
    await this.withTenant(holiday.tenantId, (tx) =>
      tx.clinicHoliday.upsert({
        where: { id: holiday.id },
        create: {
          id: holiday.id,
          tenantId: holiday.tenantId,
          fromDate: holiday.from,
          toDate: holiday.to,
          reason: holiday.reason,
        },
        update: {
          fromDate: holiday.from,
          toDate: holiday.to,
          reason: holiday.reason,
        },
      }),
    );
  }

  async findById(tenantId: string, holidayId: string): Promise<ClinicHoliday | null> {
    const record = await this.withTenant(tenantId, (tx) =>
      // tenantId no WHERE, não só no SET LOCAL da transação — defesa em
      // profundidade explícita (RLS é a segunda camada, nunca a única),
      // mesmo princípio de enable-rls.sql.
      tx.clinicHoliday.findFirst({ where: { id: holidayId, tenantId } }),
    );
    return record ? this.toDomain(record) : null;
  }

  async delete(tenantId: string, holidayId: string): Promise<void> {
    await this.withTenant(tenantId, (tx) => tx.clinicHoliday.deleteMany({ where: { id: holidayId, tenantId } }));
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

  private toDomain(record: PrismaClinicHoliday): ClinicHoliday {
    return ClinicHoliday.reconstitute({
      id: record.id,
      tenantId: record.tenantId,
      from: record.fromDate,
      to: record.toDate,
      reason: record.reason ?? undefined,
    });
  }
}
