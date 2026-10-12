import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { AppointmentRepository, APPOINTMENT_REPOSITORY } from '@domain-services/patient-ops/appointment.repository';
import { THERAPIST_REPOSITORY, TherapistRepository } from '@domain-services/platform/therapist.repository';
import { CLINIC_TIME_ZONE_READER, ClinicTimeZoneReader } from '@domain-services/platform/clinic-time-zone.reader';
import { formatCivilDate } from '@domain/shared/time-zone';
import { MessageQueueProducer } from '@infrastructure/messaging/message-queue.producer';
import { buildAgendaSummaryMessage, tomorrowAt } from '@use-cases/communication/templates/agenda-summary.template';

/**
 * EnviarResumoAgendaDoDiaUseCase — Módulo 14.
 * Fonte: 02 - CTO/clinicos/docs/05-IA/02-Rotina-de-Controle-de-Agenda.md.
 *
 * AD-039 — "amanhã" e os horários do resumo são os da clínica. A chave de
 * idempotência leva a data de amanhã no calendário dela (para São Paulo, o
 * mesmo texto de antes).
 */
@Injectable()
export class EnviarResumoAgendaDoDiaUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointmentRepo: AppointmentRepository,
    @Inject(THERAPIST_REPOSITORY) private readonly therapistRepo: TherapistRepository,
    private readonly messageQueue: MessageQueueProducer,
    @Inject(CLINIC_TIME_ZONE_READER) private readonly clinicTimeZone: ClinicTimeZoneReader,
  ) {}

  async execute(tenantId: string, therapistId: string, therapistPhone: string, correlationId?: string): Promise<void> {
    const therapist = await this.therapistRepo.findById(therapistId);
    if (!therapist) throw new NotFoundException('Terapeuta não encontrado.');

    const timeZone = await this.clinicTimeZone.current();
    const { date, from, to } = tomorrowAt(timeZone);
    const appointments = await this.appointmentRepo.findActiveByTherapistAndRange(therapistId, from, to);
    const body = buildAgendaSummaryMessage(therapist.name, appointments, timeZone);

    await this.messageQueue.enqueue({
      tenantId,
      toPhoneNumber: therapistPhone,
      body,
      idempotencyKey: `agenda-summary-${therapistId}-${formatCivilDate(date)}`,
      correlationId,
    });
  }
}
