import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { AppointmentRepository, APPOINTMENT_REPOSITORY } from '@domain-services/patient-ops/appointment.repository';
import { THERAPIST_REPOSITORY, TherapistRepository } from '@domain-services/platform/therapist.repository';
import { MessageQueueProducer } from '@infrastructure/messaging/message-queue.producer';
import { buildAgendaSummaryMessage } from '@use-cases/communication/templates/agenda-summary.template';

function tomorrowRange(): { from: Date; to: Date } {
  const from = new Date();
  from.setDate(from.getDate() + 1);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

/**
 * EnviarResumoAgendaDoDiaUseCase — Módulo 14.
 * Fonte: 02 - CTO/clinicos/docs/05-IA/02-Rotina-de-Controle-de-Agenda.md.
 */
@Injectable()
export class EnviarResumoAgendaDoDiaUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointmentRepo: AppointmentRepository,
    @Inject(THERAPIST_REPOSITORY) private readonly therapistRepo: TherapistRepository,
    private readonly messageQueue: MessageQueueProducer,
  ) {}

  async execute(tenantId: string, therapistId: string, therapistPhone: string): Promise<void> {
    const therapist = await this.therapistRepo.findById(therapistId);
    if (!therapist) throw new NotFoundException('Terapeuta não encontrado.');

    const { from, to } = tomorrowRange();
    const appointments = await this.appointmentRepo.findActiveByTherapistAndRange(therapistId, from, to);
    const body = buildAgendaSummaryMessage(therapist.name, appointments);

    await this.messageQueue.enqueue({
      tenantId,
      toPhoneNumber: therapistPhone,
      body,
      idempotencyKey: `agenda-summary-${therapistId}-${from.toISOString().slice(0, 10)}`,
    });
  }
}
