import { Injectable } from '@nestjs/common';
import { Therapist as PrismaTherapist, Prisma } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { Therapist, WeeklyAvailabilitySlot } from '@domain/therapist/therapist.entity';
import { TherapistRepository } from '@domain-services/platform/therapist.repository';

@Injectable()
export class PrismaTherapistRepository implements TherapistRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Therapist | null> {
    const record = await this.prisma.forTenant((tx) => tx.therapist.findUnique({ where: { id } }));
    return record ? this.toDomain(record) : null;
  }

  async findAllByTenant(): Promise<Therapist[]> {
    const records = await this.prisma.forTenant((tx) =>
      tx.therapist.findMany({ orderBy: { name: 'asc' } }),
    );
    return records.map((r) => this.toDomain(r));
  }

  async save(therapist: Therapist): Promise<void> {
    await this.prisma.forTenant((tx) =>
      tx.therapist.upsert({
        where: { id: therapist.id },
        create: {
          id: therapist.id,
          tenantId: therapist.tenantId,
          name: therapist.name,
          specialty: therapist.specialty,
          availability: therapist.availability as unknown as Prisma.InputJsonValue,
        },
        update: {
          name: therapist.name,
          specialty: therapist.specialty,
          availability: therapist.availability as unknown as Prisma.InputJsonValue,
        },
      }),
    );
  }

  private toDomain(record: PrismaTherapist): Therapist {
    return Therapist.reconstitute({
      id: record.id,
      tenantId: record.tenantId,
      name: record.name,
      specialty: record.specialty ?? undefined,
      phone: record.phone ?? undefined,
      availability: (record.availability as unknown as WeeklyAvailabilitySlot[] | null) ?? [],
    });
  }
}
