import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { AppointmentRepository, APPOINTMENT_REPOSITORY } from '@domain-services/patient-ops/appointment.repository';
import { THERAPIST_REPOSITORY, TherapistRepository } from '@domain-services/platform/therapist.repository';
import { CLINIC_TIME_ZONE_READER, ClinicTimeZoneReader } from '@domain-services/platform/clinic-time-zone.reader';
import { MessageQueueProducer } from '@infrastructure/messaging/message-queue.producer';
import { buildAgendaSummaryMessage, tomorrowAt } from '@use-cases/communication/templates/agenda-summary.template';

/**
 * ReenviarAgendaAtualizadaUseCase — Módulo 14.
 * Fonte: 05-IA/02-Rotina-de-Controle-de-Agenda.md: "Se a agenda muda depois
 * do envio do resumo diário, reenvia a versão atualizada imediatamente."
 *
 * Diferente de EnviarResumoAgendaDoDia (idempotencyKey fixo por dia), aqui
 * o idempotencyKey inclui o momento exato da chamada — cada reenvio É uma
 * mensagem nova e legítima (a agenda mudou de novo), não um retry.
 *
 * AD-039 — "amanhã" e os horários do resumo são os da clínica.
 */
@Injectable()
export class ReenviarAgendaAtualizadaUseCase {
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
    const { from, to } = tomorrowAt(timeZone);
    const appointments = await this.appointmentRepo.findActiveByTherapistAndRange(therapistId, from, to);
    const body = buildAgendaSummaryMessage(therapist.name, appointments, timeZone, true);

    await this.messageQueue.enqueue({
      tenantId,
      toPhoneNumber: therapistPhone,
      body,
      idempotencyKey: `agenda-summary-updated-${therapistId}-${Date.now()}`,
      correlationId,
    });
  }
}
