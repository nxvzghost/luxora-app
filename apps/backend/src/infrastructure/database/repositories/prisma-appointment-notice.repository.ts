import { Injectable } from '@nestjs/common';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { AppointmentNotice } from '@domain/appointment/appointment-notice';
import { AppointmentNoticeRepository } from '@domain-services/patient-ops/appointment-notice.repository';

/**
 * K2-b (ADR-0069, seção 3.2) — comunicação somente de acréscimo: o papel da
 * aplicação insere e lê, e só atualiza as colunas de revisão (privilégio por
 * coluna na migration). Os horários e a origem nunca são reescritos.
 */
@Injectable()
export class PrismaAppointmentNoticeRepository implements AppointmentNoticeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(notice: AppointmentNotice): Promise<void> {
    await this.prisma.forTenant((tx) =>
      tx.appointmentNotice.create({
        data: {
          id: notice.id,
          tenantId: notice.tenantId,
          appointmentId: notice.appointmentId,
          patientId: notice.patientId,
          channel: notice.channel,
          recordedAt: notice.recordedAt,
          referenceTime: notice.referenceTime,
          referenceSource: notice.referenceSource,
          timing: notice.timing,
          minutesFromStart: notice.minutesFromStart,
          limitHoursApplied: notice.limitHoursApplied,
          intent: notice.intent,
          intentSource: notice.intentSource,
          requestedBy: notice.requestedBy,
          recordedByUserId: notice.recordedByUserId,
          recordedByActorType: notice.recordedByActorType,
          reason: notice.reason,
          reviewStatus: notice.reviewStatus,
        },
      }),
    );
  }
}
