import { ConflictException, Injectable } from '@nestjs/common';
import { AppointmentOutcomeRecord as PrismaOutcome, Prisma } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { AppointmentDecisionRecord, AppointmentOutcomeRecord } from '@domain/appointment/appointment-outcome';
import { AppointmentState } from '@domain/appointment/appointment.entity';
import { AppointmentOutcomeRepository } from '@domain-services/patient-ops/appointment-outcome.repository';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

/**
 * K2-b (ADR-0069, seções 2.4 e 3.2b). O papel da aplicação insere e lê o
 * desfecho e só atualiza as colunas de desfecho e de decisão — o resto da
 * linha (retrato, consulta, clínica, autoria) não tem privilégio de UPDATE,
 * e a linha não pode ser apagada. Por isso `saveDecision()` é um UPDATE
 * dessas colunas, nunca um upsert.
 */
@Injectable()
export class PrismaAppointmentOutcomeRepository implements AppointmentOutcomeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByAppointmentId(appointmentId: string): Promise<AppointmentOutcomeRecord | null> {
    const record = await this.prisma.forTenant((tx) => tx.appointmentOutcomeRecord.findUnique({ where: { appointmentId } }));
    return record ? this.toDomain(record) : null;
  }

  async findByAppointmentIdForUpdate(appointmentId: string): Promise<AppointmentOutcomeRecord | null> {
    if (!this.prisma.isInUnitOfWork) {
      throw new Error('findByAppointmentIdForUpdate() só pode ser chamado dentro de uma unidade de trabalho.');
    }
    const record = await this.prisma.forTenant(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ appointment_id: string }>>`
        SELECT appointment_id FROM "appointment_outcome" WHERE appointment_id = ${appointmentId} FOR UPDATE`;
      if (locked.length === 0) return null;
      return tx.appointmentOutcomeRecord.findUnique({ where: { appointmentId } });
    });
    return record ? this.toDomain(record) : null;
  }

  async findByAppointmentIds(appointmentIds: string[]): Promise<Map<string, AppointmentOutcomeRecord>> {
    if (appointmentIds.length === 0) return new Map();
    const records = await this.prisma.forTenant((tx) =>
      tx.appointmentOutcomeRecord.findMany({ where: { appointmentId: { in: appointmentIds } } }),
    );
    return new Map(records.map((record) => [record.appointmentId, this.toDomain(record)]));
  }

  async insert(record: AppointmentOutcomeRecord): Promise<void> {
    try {
      await this.prisma.forTenant((tx) =>
        tx.appointmentOutcomeRecord.create({
          data: {
            appointmentId: record.appointmentId,
            tenantId: record.tenantId,
            outcome: record.outcome,
            outcomeRecordedAt: record.recordedAt,
            outcomeRecordedByUserId: record.recordedByUserId,
            stateAtOutcome: record.stateAtOutcome,
            scheduledAtAtOutcome: record.scheduledAtAtOutcome,
            modalityAtOutcome: record.modalityAtOutcome,
            closingNoticeId: record.closingNoticeId,
            closingNoticeTiming: record.closingNoticeTiming,
            ...this.decisionColumns(record),
          },
        }),
      );
    } catch (err) {
      // Dois registros de desfecho ao mesmo tempo: a chave primária é a consulta.
      if ((err as Prisma.PrismaClientKnownRequestError)?.code === UNIQUE_CONSTRAINT_VIOLATION) {
        throw new ConflictException({
          code: 'APPOINTMENT_OUTCOME_CONFLICT',
          message: 'Esta consulta já tem desfecho registrado.',
          category: 'business_rule',
        });
      }
      throw err;
    }
  }

  async saveDecision(record: AppointmentOutcomeRecord): Promise<void> {
    await this.prisma.forTenant((tx) =>
      tx.appointmentOutcomeRecord.update({
        where: { appointmentId: record.appointmentId },
        data: { outcome: record.outcome, ...this.decisionColumns(record) },
      }),
    );
  }

  async insertDecision(decision: AppointmentDecisionRecord): Promise<void> {
    await this.prisma.forTenant((tx) =>
      tx.appointmentDecision.create({
        data: {
          id: decision.id,
          tenantId: decision.tenantId,
          appointmentId: decision.appointmentId,
          decision: decision.decision,
          reason: decision.reason,
          decidedAt: decision.decidedAt,
          decidedByUserId: decision.decidedByUserId,
        },
      }),
    );
  }

  // `null` explícito: uma decisão desfeita (abono revertido) limpa a coluna.
  private decisionColumns(record: AppointmentOutcomeRecord) {
    return {
      noShowDecision: record.noShowDecision ?? null,
      noShowDecisionAt: record.noShowDecisionAt ?? null,
      noShowDecisionByUserId: record.noShowDecisionByUserId ?? null,
      lateNoticeDecision: record.lateNoticeDecision ?? null,
      lateNoticeDecisionAt: record.lateNoticeDecisionAt ?? null,
      lateNoticeDecisionByUserId: record.lateNoticeDecisionByUserId ?? null,
    };
  }

  private toDomain(record: PrismaOutcome): AppointmentOutcomeRecord {
    return AppointmentOutcomeRecord.reconstitute({
      appointmentId: record.appointmentId,
      tenantId: record.tenantId,
      outcome: record.outcome,
      recordedAt: record.outcomeRecordedAt,
      recordedByUserId: record.outcomeRecordedByUserId,
      stateAtOutcome: record.stateAtOutcome as AppointmentState,
      scheduledAtAtOutcome: record.scheduledAtAtOutcome,
      modalityAtOutcome: record.modalityAtOutcome,
      closingNoticeId: record.closingNoticeId ?? undefined,
      closingNoticeTiming: record.closingNoticeTiming ?? undefined,
      noShowDecision: record.noShowDecision ?? undefined,
      noShowDecisionAt: record.noShowDecisionAt ?? undefined,
      noShowDecisionByUserId: record.noShowDecisionByUserId ?? undefined,
      lateNoticeDecision: record.lateNoticeDecision ?? undefined,
      lateNoticeDecisionAt: record.lateNoticeDecisionAt ?? undefined,
      lateNoticeDecisionByUserId: record.lateNoticeDecisionByUserId ?? undefined,
    });
  }
}
