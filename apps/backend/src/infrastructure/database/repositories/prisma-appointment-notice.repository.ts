import { Injectable } from '@nestjs/common';
import { AppointmentNotice as PrismaNotice } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { AppointmentNotice } from '@domain/appointment/appointment-notice';
import { AppointmentNoticeRepository, AppointmentRequestThread } from '@domain-services/patient-ops/appointment-notice.repository';

/**
 * K2-b (ADR-0069, seção 3.2) — comunicação somente de acréscimo: o papel da
 * aplicação insere e lê, e só atualiza as colunas de revisão (privilégio por
 * coluna na migration). Os horários e a origem nunca são reescritos.
 *
 * K11 — o pedido pelo WhatsApp e a resposta do paciente também são só
 * inseridos: o estado do pedido é derivado, nunca gravado.
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
          messageId: notice.messageId,
          receivedAt: notice.receivedAt,
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
          conversationId: notice.conversationId,
          awaitsConfirmation: notice.awaitsConfirmation,
          requestedAction: notice.requestedAction,
          askedScheduledAt: notice.askedScheduledAt,
          askedModality: notice.askedModality,
          proposedScheduledAt: notice.proposedScheduledAt,
          confirmsNoticeId: notice.confirmsNoticeId,
          confirmationAnswer: notice.confirmationAnswer,
        },
      }),
    );
  }

  async findByMessageId(messageId: string): Promise<AppointmentNotice | null> {
    const record = await this.prisma.forTenant((tx) => tx.appointmentNotice.findUnique({ where: { messageId } }));
    return record ? this.toDomain(record) : null;
  }

  async findRequests(query: { since: Date; conversationId?: string }): Promise<AppointmentRequestThread[]> {
    const records = await this.prisma.forTenant((tx) =>
      tx.appointmentNotice.findMany({
        where: {
          awaitsConfirmation: true,
          recordedAt: { gte: query.since },
          ...(query.conversationId ? { conversationId: query.conversationId } : {}),
        },
        include: { replies: { orderBy: [{ receivedAt: 'asc' }, { recordedAt: 'asc' }] } },
        orderBy: [{ receivedAt: 'asc' }, { recordedAt: 'asc' }],
      }),
    );
    return records.map((record) => ({
      request: this.toDomain(record),
      replies: record.replies.map((reply) => this.toDomain(reply)),
    }));
  }

  private toDomain(record: PrismaNotice): AppointmentNotice {
    return AppointmentNotice.reconstitute({
      id: record.id,
      tenantId: record.tenantId,
      appointmentId: record.appointmentId,
      patientId: record.patientId,
      channel: record.channel,
      recordedAt: record.recordedAt,
      referenceTime: record.referenceTime,
      referenceSource: record.referenceSource,
      classification: {
        timing: record.timing,
        minutesFromStart: record.minutesFromStart,
        limitHoursApplied: record.limitHoursApplied ?? undefined,
      },
      intent: record.intent,
      intentSource: record.intentSource,
      requestedBy: record.requestedBy ?? undefined,
      recordedByUserId: record.recordedByUserId ?? undefined,
      recordedByActorType: record.recordedByActorType,
      reason: record.reason ?? undefined,
      reviewStatus: record.reviewStatus,
      messageId: record.messageId ?? undefined,
      receivedAt: record.receivedAt ?? undefined,
      conversationId: record.conversationId ?? undefined,
      awaitsConfirmation: record.awaitsConfirmation,
      requestedAction: record.requestedAction ?? undefined,
      askedScheduledAt: record.askedScheduledAt ?? undefined,
      askedModality: record.askedModality ?? undefined,
      proposedScheduledAt: record.proposedScheduledAt ?? undefined,
      confirmsNoticeId: record.confirmsNoticeId ?? undefined,
      confirmationAnswer: record.confirmationAnswer ?? undefined,
    });
  }
}
