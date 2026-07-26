import { Injectable } from '@nestjs/common';
import { AvailabilityCalendar as PrismaAvailabilityCalendar, Prisma } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import {
  AvailabilityCalendar,
  AvailabilityException,
  AvailabilityWindow,
} from '@domain/availability/availability-calendar.entity';
import { AvailabilityRepository } from '@domain-services/availability/availability.repository';

@Injectable()
export class PrismaAvailabilityRepository implements AvailabilityRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByTherapistId(therapistId: string): Promise<AvailabilityCalendar | null> {
    const record = await this.prisma.forTenant((tx) =>
      tx.availabilityCalendar.findUnique({ where: { therapistId } }),
    );
    return record ? this.toDomain(record) : null;
  }

  async save(calendar: AvailabilityCalendar): Promise<void> {
    await this.prisma.forTenant((tx) =>
      tx.availabilityCalendar.upsert({
        where: { id: calendar.id },
        create: {
          id: calendar.id,
          tenantId: calendar.tenantId,
          therapistId: calendar.therapistId,
          windows: calendar.windows as unknown as Prisma.InputJsonValue,
          exceptions: calendar.exceptions as unknown as Prisma.InputJsonValue,
        },
        update: {
          windows: calendar.windows as unknown as Prisma.InputJsonValue,
          exceptions: calendar.exceptions as unknown as Prisma.InputJsonValue,
        },
      }),
    );
  }

  private toDomain(record: PrismaAvailabilityCalendar): AvailabilityCalendar {
    return AvailabilityCalendar.reconstitute({
      id: record.id,
      tenantId: record.tenantId,
      therapistId: record.therapistId,
      windows: (record.windows as unknown as AvailabilityWindow[]) ?? [],
      exceptions: this.parseExceptions(record.exceptions),
    });
  }

  /**
   * JSON não tem tipo Date — `from`/`to` voltam do Postgres como strings ISO,
   * nunca instâncias de Date. Sem esta conversão explícita, `isExcepted()`
   * compararia `Date < string` (sempre `false`, já que o motor de relacionais
   * do JS converte a string para `NaN`) — a exceção seria lida do banco mas
   * nunca teria efeito real na disponibilidade. Mesmo cuidado que qualquer
   * campo JSON com datas exige, independente do ORM.
   */
  private parseExceptions(raw: unknown): AvailabilityException[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((e) => ({
      from: new Date((e as { from: string }).from),
      to: new Date((e as { to: string }).to),
      reason: (e as { reason?: string }).reason,
    }));
  }
}
