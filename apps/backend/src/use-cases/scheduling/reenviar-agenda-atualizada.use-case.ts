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
 * ReenviarAgendaAtualizadaUseCase — Módulo 14.
 * Fonte: 05-IA/02-Rotina-de-Controle-de-Agenda.md: "Se a agenda muda depois
 * do envio do resumo diário, reenvia a versão atualizada imediatamente."
 *
 * Diferente de EnviarResumoAgendaDoDia (idempotencyKey fixo por dia), aqui
 * o idempotencyKey inclui o momento exato da chamada — cada reenvio É uma
 * mensagem nova e legítima (a agenda mudou de novo), não um retry.
 */
@Injectable()
export class ReenviarAgendaAtualizadaUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointmentRepo: AppointmentRepository,
    @Inject(THERAPIST_REPOSITORY) private readonly therapistRepo: TherapistRepository,
    private readonly messageQueue: MessageQueueProducer,
  ) {}

  async execute(tenantId: string, therapistId: string, therapistPhone: string, correlationId?: string): Promise<void> {
    const therapist = await this.therapistRepo.findById(therapistId);
    if (!therapist) throw new NotFoundException('Terapeuta não encontrado.');

    const { from, to } = tomorrowRange();
    const appointments = await this.appointmentRepo.findActiveByTherapistAndRange(therapistId, from, to);
    const body = buildAgendaSummaryMessage(therapist.name, appointments, true);

    await this.messageQueue.enqueue({
      tenantId,
      toPhoneNumber: therapistPhone,
      body,
      idempotencyKey: `agenda-summary-updated-${therapistId}-${Date.now()}`,
      correlationId,
    });
  }
}
