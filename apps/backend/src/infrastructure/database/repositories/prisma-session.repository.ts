import { Injectable } from '@nestjs/common';
import { Session as PrismaSession } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { Session, SessionState } from '@domain/session/session.entity';
import { SessionFilter, SessionRepository, SessionSummary } from '@domain-services/patient-ops/session.repository';

@Injectable()
export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Session | null> {
    const record = await this.prisma.forTenant((tx) => tx.session.findUnique({ where: { id } }));
    return record ? this.toDomain(record) : null;
  }

  async save(session: Session): Promise<void> {
    await this.prisma.forTenant((tx) =>
      tx.session.upsert({
        where: { id: session.id },
        create: {
          id: session.id,
          tenantId: session.tenantId,
          appointmentId: session.appointmentId,
          patientId: session.patientId,
          therapistId: session.therapistId,
          state: session.state as PrismaSession['state'],
        },
        update: {
          state: session.state as PrismaSession['state'],
        },
      }),
    );
  }

  async findSummaries(filter: SessionFilter = {}): Promise<SessionSummary[]> {
    const records = await this.prisma.forTenant((tx) =>
      tx.session.findMany({
        where: {
          ...(filter.state ? { state: filter.state as PrismaSession['state'] } : {}),
          ...(filter.patientId ? { patientId: filter.patientId } : {}),
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
    });
  }
}
