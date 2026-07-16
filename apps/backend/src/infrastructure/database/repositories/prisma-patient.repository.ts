import { Injectable } from '@nestjs/common';
import { Patient as PrismaPatient } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { Patient, PatientState } from '@domain/patient/patient.entity';
import { PatientRepository } from '@domain-services/patient-ops/patient.repository';

/**
 * PrismaPatientRepository — implementação da porta PatientRepository.
 * Único lugar do sistema que converte entre o registro do Prisma e a
 * entidade de Domain — ver ADR-0026 (reconciliação de estados).
 *
 * Toda operação passa por PrismaService.forTenant() — nunca acessa o
 * PrismaClientProvider diretamente (regra reforçada no Módulo 04).
 */
@Injectable()
export class PrismaPatientRepository implements PatientRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Patient | null> {
    const record = await this.prisma.forTenant((tx) => tx.patient.findUnique({ where: { id } }));
    return record ? this.toDomain(record) : null;
  }

  async findAllByTenant(params?: { cursor?: string; limit?: number }): Promise<Patient[]> {
    const limit = params?.limit ?? 20;
    const records = await this.prisma.forTenant((tx) =>
      tx.patient.findMany({
        take: limit,
        ...(params?.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
        orderBy: { createdAt: 'desc' },
      }),
    );
    return records.map((r) => this.toDomain(r));
  }

  async save(patient: Patient): Promise<void> {
    await this.prisma.forTenant((tx) =>
      tx.patient.upsert({
        where: { id: patient.id },
        create: {
          id: patient.id,
          tenantId: patient.tenantId,
          name: patient.name,
          phone: patient.phone,
          state: patient.state as PrismaPatient['state'],
          billingPolicyOverride: patient.billingPolicyOverride,
        },
        update: {
          name: patient.name,
          state: patient.state as PrismaPatient['state'],
          billingPolicyOverride: patient.billingPolicyOverride,
        },
      }),
    );
  }

  private toDomain(record: PrismaPatient): Patient {
    return Patient.reconstitute({
      id: record.id,
      tenantId: record.tenantId,
      name: record.name,
      phone: record.phone,
      state: record.state as PatientState,
      billingPolicyOverride: record.billingPolicyOverride ?? undefined,
    });
  }
}
