import { Inject, Injectable } from '@nestjs/common';
import { Appointment } from '@domain/appointment/appointment.entity';
import { AppointmentRequestView, deriveRequestStatus } from '@domain/appointment/appointment-request';
import { APPOINTMENT_REPOSITORY, AppointmentRepository } from '@domain-services/patient-ops/appointment.repository';
import { APPOINTMENT_OUTCOME_REPOSITORY, AppointmentOutcomeRepository } from '@domain-services/patient-ops/appointment-outcome.repository';
import { APPOINTMENT_NOTICE_REPOSITORY, AppointmentNoticeRepository } from '@domain-services/patient-ops/appointment-notice.repository';
import { CLOCK, Clock } from '@domain-services/platform/clock';
import { REQUEST_LOOKBACK_DAYS } from './pedido-pelo-whatsapp.use-case';

const DAY_MS = 86_400_000;
/** Pedidos que pedem a equipe saem da lista quando a consulta é resolvida, ou 14 dias depois dela. */
const ATTENTION_WINDOW_DAYS = 14;
/** Pedidos executados pela IA ficam visíveis por 7 dias, com a autoria "IA, confirmado pelo paciente". */
const CONFIRMED_WINDOW_DAYS = 7;

export interface PendingRequestItem extends AppointmentRequestView {
  appointment: Appointment;
}

/**
 * ListarPedidosPeloWhatsAppUseCase — K11 (ADR-0069; D2, D6).
 *
 * As pendências da equipe: pedidos de cancelamento ou remarcação feitos pelo
 * WhatsApp que ainda esperam o paciente (`aguardando`) ou que pedem alguém
 * da clínica (`vencido`, `encaminhado`, `nao_executado`). O estado é
 * derivado aqui, na leitura (sem agendador, D6). Um pedido que pede a equipe
 * sai da lista quando a consulta é resolvida (ganha desfecho ou deixa de
 * estar aberta) ou 14 dias depois do horário dela.
 *
 * Os pedidos que a IA executou (`confirmado`) ficam por 7 dias, para a
 * equipe ver o que mudou e por quê ("IA, confirmado pelo paciente"): a
 * consulta cancelada sai da agenda, e o desfecho de uma remarcação fica na
 * ocorrência anterior.
 */
@Injectable()
export class ListarPedidosPeloWhatsAppUseCase {
  constructor(
    @Inject(APPOINTMENT_NOTICE_REPOSITORY) private readonly notices: AppointmentNoticeRepository,
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointments: AppointmentRepository,
    @Inject(APPOINTMENT_OUTCOME_REPOSITORY) private readonly outcomes: AppointmentOutcomeRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(): Promise<PendingRequestItem[]> {
    const now = this.clock.now();
    const threads = await this.notices.findRequests({ since: new Date(now.getTime() - REQUEST_LOOKBACK_DAYS * DAY_MS) });

    // O pedido mais novo de cada conversa: os anteriores foram substituídos.
    const latestByConversation = new Map<string, string>();
    for (const { request } of threads) latestByConversation.set(request.conversationId ?? request.id, request.id);

    const appointmentIds = [...new Set(threads.map(({ request }) => request.appointmentId))];
    const appointments = new Map<string, Appointment>();
    for (const id of appointmentIds) {
      const appointment = await this.appointments.findById(id);
      if (appointment) appointments.set(id, appointment);
    }
    const outcomes = await this.outcomes.findByAppointmentIds(appointmentIds);
    const attentionSince = now.getTime() - ATTENTION_WINDOW_DAYS * DAY_MS;
    const confirmedSince = now.getTime() - CONFIRMED_WINDOW_DAYS * DAY_MS;

    const items: PendingRequestItem[] = [];
    for (const thread of threads) {
      const appointment = appointments.get(thread.request.appointmentId) ?? null;
      const outcome = outcomes.get(thread.request.appointmentId) ?? null;
      const superseded = latestByConversation.get(thread.request.conversationId ?? thread.request.id) !== thread.request.id;
      const status = deriveRequestStatus({ ...thread, appointment, outcome, superseded, now });
      if (!appointment) continue;
      const waiting = status === 'aguardando';
      const needsTeam =
        (status === 'vencido' || status === 'encaminhado' || status === 'nao_executado') &&
        appointment.isOpen &&
        !outcome &&
        appointment.scheduledAt.getTime() >= attentionSince;
      const recentlyDone = status === 'confirmado' && !!outcome && outcome.recordedAt.getTime() >= confirmedSince;
      if (waiting || needsTeam || recentlyDone) items.push({ ...thread, status, appointment });
    }
    return items.sort((a, b) => a.appointment.scheduledAt.getTime() - b.appointment.scheduledAt.getTime());
  }
}
