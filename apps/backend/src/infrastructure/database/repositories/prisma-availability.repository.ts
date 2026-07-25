import { Injectable } from '@nestjs/common';
import { AvailabilityCalendar as PrismaAvailabilityCalendar, Prisma } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { AvailabilityCalendar, AvailabilityWindow } from '@domain/availability/availability-calendar.entity';
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
        },
        update: {
          windows: calendar.windows as unknown as Prisma.InputJsonValue,
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
    });
  }
}
