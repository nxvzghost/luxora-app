import { Injectable } from '@nestjs/common';
import { Prisma, Session as PrismaSession } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { Session, SessionState } from '@domain/session/session.entity';
import { SessionFilter, SessionRepository, SessionSummary } from '@domain-services/patient-ops/session.repository';

/**
 * K2-b (ADR-0069, seção 2.9) — o que uma sessão precisa para entrar numa
 * cobrança nova, escrito como filtro: a faturar, com kind, elegível e sem
 * anulação. O mesmo critério de Session.isBillable.
 */
const BILLABLE: Prisma.SessionWhereInput = {
  state: 'Realizada',
  kind: { not: null },
  billingEligibility: 'elegivel',
  voidedAt: null,
};

@Injectable()
export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Session | null> {
    const record = await this.prisma.forTenant((tx) => tx.session.findUnique({ where: { id } }));
    return record ? this.toDomain(record) : null;
  }

  async findByAppointmentId(appointmentId: string): Promise<Session | null> {
    const record = await this.prisma.forTenant((tx) => tx.session.findUnique({ where: { appointmentId } }));
    return record ? this.toDomain(record) : null;
  }

  /**
   * K2-b — grava também o item faturável (kind, elegibilidade, anulação) e o
   * momento do registro (`completed_at`, achado 1 da ADR-0069: nunca era
   * gravado). O banco confere a coerência: elegível só com kind e sem
   * anulação, e uma sessão vinculada não deixa de ser elegível.
   */
  async save(session: Session): Promise<void> {
    const billableItem = {
      state: session.state as PrismaSession['state'],
      completedAt: session.completedAt ?? null,
      kind: session.kind ?? null,
      billingEligibility: session.billingEligibility,
      voidedAt: session.voidedAt ?? null,
      voidReason: session.voidReason ?? null,
      voidedByUserId: session.voidedByUserId ?? null,
    };
    await this.prisma.forTenant((tx) =>
      tx.session.upsert({
        where: { id: session.id },
        create: {
          id: session.id,
          tenantId: session.tenantId,
          appointmentId: session.appointmentId,
          patientId: session.patientId,
          therapistId: session.therapistId,
          ...billableItem,
        },
        update: billableItem,
      }),
    );
  }

  async findSummaries(filter: SessionFilter = {}): Promise<SessionSummary[]> {
    const records = await this.prisma.forTenant((tx) =>
      tx.session.findMany({
        where: {
          ...(filter.state ? { state: filter.state as PrismaSession['state'] } : {}),
          ...(filter.patientId ? { patientId: filter.patientId } : {}),
          ...(filter.billableOnly ? BILLABLE : {}),
        },
        include: { appointment: { select: { scheduledAt: true } } },
        orderBy: { appointment: { scheduledAt: 'desc' } },
        take: filter.limit ?? 200,
      }),
    );
    return records.map((record) => ({
      id: record.id,
      appointmentId: record.appointmentId,
      patientId: record.patientId,
      therapistId: record.therapistId,
      state: record.state as SessionState,
      scheduledAt: record.appointment.scheduledAt,
      kind: record.kind,
      billingEligibility: record.billingEligibility,
      voidedAt: record.voidedAt,
    }));
  }

  private toDomain(record: PrismaSession): Session {
    return Session.reconstitute({
      id: record.id,
      tenantId: record.tenantId,
      appointmentId: record.appointmentId,
      patientId: record.patientId,
      therapistId: record.therapistId,
      state: record.state as SessionState,
      completedAt: record.completedAt ?? undefined,
      kind: record.kind ?? undefined,
      billingEligibility: record.billingEligibility,
      voidedAt: record.voidedAt ?? undefined,
      voidReason: record.voidReason ?? undefined,
      voidedByUserId: record.voidedByUserId ?? undefined,
    });
  }
}
