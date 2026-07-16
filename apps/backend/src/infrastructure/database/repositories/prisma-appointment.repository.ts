import { Injectable, ConflictException } from '@nestjs/common';
import { Appointment as PrismaAppointment, Prisma } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { Appointment, AppointmentState } from '@domain/appointment/appointment.entity';
import { AppointmentRepository } from '@domain-services/patient-ops/appointment.repository';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

@Injectable()
export class PrismaAppointmentRepository implements AppointmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Appointment | null> {
    const record = await this.prisma.forTenant((tx) => tx.appointment.findUnique({ where: { id } }));
    return record ? this.toDomain(record) : null;
  }

  async findActiveByTherapistAndRange(therapistId: string, from: Date, to: Date): Promise<Appointment[]> {
    const records = await this.prisma.forTenant((tx) =>
      tx.appointment.findMany({
        where: {
          therapistId,
          scheduledAt: { gte: from, lte: to },
          state: { not: 'Cancelada' },
        },
        orderBy: { scheduledAt: 'asc' },
      }),
    );
    return records.map((r) => this.toDomain(r));
  }

  async findByTenantAndRange(from: Date, to: Date): Promise<Appointment[]> {
    const records = await this.prisma.forTenant((tx) =>
      tx.appointment.findMany({
        where: { scheduledAt: { gte: from, lte: to }, state: { not: 'Cancelada' } },
        orderBy: { scheduledAt: 'asc' },
      }),
    );
    return records.map((r) => this.toDomain(r));
  }

  async save(appointment: Appointment): Promise<void> {
    try {
      await this.prisma.forTenant((tx) =>
        tx.appointment.upsert({
          where: { id: appointment.id },
          create: {
            id: appointment.id,
            tenantId: appointment.tenantId,
            patientId: appointment.patientId,
            therapistId: appointment.therapistId,
            scheduledAt: appointment.scheduledAt,
            state: appointment.state as PrismaAppointment['state'],
            recurring: appointment.isRecurring,
          },
          update: {
            scheduledAt: appointment.scheduledAt,
            state: appointment.state as PrismaAppointment['state'],
          },
        }),
      );
    } catch (err) {
      // Índice único parcial (prisma/rls/unique-active-appointment.sql) —
      // ver ADR-0028. Traduz o erro de constraint do Postgres para o
      // SESSION_CONFLICT já documentado em 04-API/00-Principios-da-API.md,
      // nunca deixando vazar um erro genérico de banco para a API.
      if ((err as Prisma.PrismaClientKnownRequestError)?.code === UNIQUE_CONSTRAINT_VIOLATION) {
        throw new ConflictException({
          code: 'SESSION_CONFLICT',
          message: 'O horário selecionado já está reservado.',
          category: 'business_rule',
        });
      }
      throw err;
    }
  }

  private toDomain(record: PrismaAppointment): Appointment {
    return Appointment.reconstitute({
      id: record.id,
      tenantId: record.tenantId,
      patientId: record.patientId,
      therapistId: record.therapistId,
      scheduledAt: record.scheduledAt,
      modality: record.modality as 'presencial' | 'online',
      state: record.state as AppointmentState,
      recurring: record.recurring,
    });
  }
}
