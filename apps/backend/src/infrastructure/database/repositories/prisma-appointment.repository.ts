import { Injectable, ConflictException } from '@nestjs/common';
import { Appointment as PrismaAppointment, Prisma, PrismaClient } from '@prisma/client';
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
    await this.saveMany([appointment]);
  }

  /**
   * PD-001 Fase 2, C3 — checagem de idempotência da materialização de
   * RecurringBlock. `tenantId` não entra na query: `recurringBlockId` já é
   * uma chave suficientemente específica (um bloco pertence a um único
   * Tenant), e este método roda dentro do mesmo `PrismaService.forTenant()`
   * que todo o resto do Repository — RLS já garante o isolamento.
   */
  async existsForRecurringBlockOccurrence(recurringBlockId: string, scheduledAt: Date): Promise<boolean> {
    const record = await this.prisma.forTenant((tx) =>
      tx.appointment.findUnique({
        where: { recurringBlockId_scheduledAt: { recurringBlockId, scheduledAt } },
        select: { id: true },
      }),
    );
    return record !== null;
  }

  /**
   * Ver contrato completo em AppointmentRepository.saveMany. Reusa o mesmo
   * upsert + tradução de erro de `save()` (que agora delega para cá com um
   * array de 1) — nenhuma lógica duplicada entre os dois.
   */
  async saveMany(appointments: Appointment[], tx?: unknown): Promise<void> {
    try {
      if (tx) {
        await this.upsertAll(tx as PrismaClient, appointments);
      } else {
        await this.prisma.forTenant((client) => this.upsertAll(client, appointments));
      }
    } catch (err) {
      // Índice único parcial (prisma/rls/unique-active-appointment.sql) —
      // ver ADR-0028. Traduz o erro de constraint do Postgres para o
      // SESSION_CONFLICT já documentado em 04-API/00-Principios-da-API.md,
      // nunca deixando vazar um erro genérico de banco para a API — vale
      // tanto para 1 Appointment quanto para um lote inteiro.
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

  private async upsertAll(client: PrismaClient, appointments: Appointment[]): Promise<void> {
    for (const appointment of appointments) {
      await client.appointment.upsert({
        where: { id: appointment.id },
        create: {
          id: appointment.id,
          tenantId: appointment.tenantId,
          patientId: appointment.patientId,
          therapistId: appointment.therapistId,
          scheduledAt: appointment.scheduledAt,
          modality: appointment.modality,
          state: appointment.state as PrismaAppointment['state'],
          recurring: appointment.isRecurring,
          recurringBlockId: appointment.recurringBlockId,
        },
        update: {
          scheduledAt: appointment.scheduledAt,
          modality: appointment.modality,
          state: appointment.state as PrismaAppointment['state'],
        },
      });
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
      recurringBlockId: record.recurringBlockId ?? undefined,
    });
  }
}
