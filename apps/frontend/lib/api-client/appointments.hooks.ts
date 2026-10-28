'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { useAuthStore } from '@/lib/stores/auth.store';

/**
 * appointments.hooks — Fase 9.3 (AD-015) e Tarefa 05 da auditoria.
 * Todas as rotas já existiam e já são protegidas por RBAC (admin e
 * therapist): o que faltava era a tela usá-las para criar e remarcar.
 *
 * K2-b (ADR-0069) — desfecho da consulta: realização, falta, cobrança da
 * falta, abono e reversão. Confirmar não cria mais sessão; a sessão a cobrar
 * nasce do registro da realização (ou da cobrança da falta).
 */
export type OutcomeName = 'Realizada' | 'Falta' | 'FaltaAbonada' | 'AvisoTardio' | 'Remarcada' | 'Cancelada';

export interface AppointmentOutcome {
  outcome: OutcomeName;
  recordedAt: string;
  /** K11 — `ai_agent`: cancelamento ou remarcação pela IA, confirmado pelo paciente no WhatsApp. */
  recordedBy?: 'user' | 'ai_agent';
  noShowDecision: 'aguardando_decisao' | 'cobranca_confirmada' | null;
  lateNoticeDecision: 'aguardando_decisao' | 'sem_cobranca' | 'cobranca_confirmada' | null;
  noticeTiming: string | null;
}

/** K11 — estado de um pedido pelo WhatsApp, calculado pela API (ADR-0069, D2 e D6). */
export type WhatsAppRequestStatus = 'aguardando' | 'vencido' | 'encaminhado' | 'nao_executado' | 'confirmado';

/** K11 — pedido de cancelamento ou remarcação pelo WhatsApp na lista de pendências. */
export interface WhatsAppRequest {
  id: string;
  status: WhatsAppRequestStatus;
  requestedAction: 'cancelar' | 'remarcar' | null;
  intent: string;
  timing: string;
  receivedAt: string;
  askedScheduledAt: string | null;
  proposedScheduledAt: string | null;
  lastAnswer: 'confirma' | 'recusa' | 'ambigua' | null;
  appointment: { id: string; patientId: string; therapistId: string; scheduledAt: string; modality: string; state: string };
}

export interface Appointment {
  id: string;
  patientId: string;
  therapistId: string;
  scheduledAt: string;
  modality?: string;
  state: string;
  recurring: boolean;
  rescheduledFromId?: string | null;
  outcome?: AppointmentOutcome | null;
}

export interface AvailableSlot {
  startsAt: string;
  endsAt: string;
}

export type Modality = 'presencial' | 'online';

/** Quem pediu o cancelamento ou a remarcação (DP-25): registrado à parte de quem registrou. */
export type RequestedBy = 'paciente' | 'clinica' | 'profissional';

/** Consultas de um intervalo. A API não devolve as canceladas (nem as remarcadas: a ocorrência nova aparece no lugar). */
export function useAppointments(from: Date, to: Date) {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['appointments', from.toISOString(), to.toISOString()],
    queryFn: () => apiRequest<{ data: Appointment[] }>(`/appointments?from=${from.toISOString()}&to=${to.toISOString()}`, { token }),
    enabled: !!token,
  });
}

/**
 * Horários livres de um terapeuta num intervalo — já descontadas as
 * consultas marcadas, as exceções e os feriados da clínica. É a fonte da
 * verdade do que pode ser agendado: a tela só oferece o que vem daqui.
 */
export function useAvailableSlots(therapistId: string, from: Date | null, to: Date | null) {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['availability-slots', therapistId, from?.toISOString(), to?.toISOString()],
    queryFn: () =>
      apiRequest<{ data: AvailableSlot[] }>(
        `/therapists/${therapistId}/availability?from=${(from as Date).toISOString()}&to=${(to as Date).toISOString()}`,
        { token },
      ),
    enabled: !!token && !!therapistId && !!from && !!to,
    // Um horário livre deixa de ser em segundos; não vale mostrar lista velha.
    staleTime: 0,
  });
}

/**
 * K11 — pendências dos pedidos pelo WhatsApp: aguardando a confirmação do
 * paciente, vencidos ou que precisam da equipe. A lista é recalculada a cada
 * leitura (o pedido vence sem agendador).
 */
export function useWhatsAppRequests() {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['appointments', 'whatsapp-requests'],
    queryFn: () => apiRequest<{ data: WhatsAppRequest[] }>('/appointments/whatsapp-requests', { token }),
    enabled: !!token,
  });
}

function useInvalidateAgenda() {
  const queryClient = useQueryClient();
  return () => {
    // Também as pendências do WhatsApp (mesma raiz da chave): resolver a consulta as tira da lista.
    queryClient.invalidateQueries({ queryKey: ['appointments'] });
    queryClient.invalidateQueries({ queryKey: ['availability-slots'] });
    // A realização e a cobrança da falta criam a sessão que depois será cobrada.
    queryClient.invalidateQueries({ queryKey: ['sessions'] });
  };
}

export function useCreateAppointment() {
  const token = useAuthStore((s) => s.accessToken);
  const invalidate = useInvalidateAgenda();
  return useMutation({
    mutationFn: (input: { patientId: string; therapistId: string; scheduledAt: string; modality: Modality }) =>
      apiRequest<Appointment>('/appointments', { method: 'POST', body: input, token }),
    // Também quando falha: se o horário foi ocupado por outra pessoa, a lista de livres precisa refletir isso.
    onSettled: invalidate,
  });
}

/** K2-b — a remarcação cria uma ocorrência nova: a resposta traz a anterior (encerrada) e a atual. */
export function useRescheduleAppointment() {
  const token = useAuthStore((s) => s.accessToken);
  const invalidate = useInvalidateAgenda();
  return useMutation({
    mutationFn: ({ appointmentId, ...body }: { appointmentId: string; newScheduledAt: string; requestedBy: RequestedBy; reason?: string }) =>
      apiRequest<{ previous: Appointment; current: Appointment }>(`/appointments/${appointmentId}/reschedule`, { method: 'PATCH', body, token }),
    onSettled: invalidate,
  });
}

export function useConfirmAppointment() {
  const token = useAuthStore((s) => s.accessToken);
  const invalidate = useInvalidateAgenda();
  return useMutation({
    mutationFn: (appointmentId: string) => apiRequest(`/appointments/${appointmentId}/confirm`, { method: 'POST', token }),
    onSettled: invalidate,
  });
}

export function useCancelAppointment() {
  const token = useAuthStore((s) => s.accessToken);
  const invalidate = useInvalidateAgenda();
  return useMutation({
    mutationFn: ({ appointmentId, ...body }: { appointmentId: string; requestedBy: RequestedBy; reason?: string }) =>
      apiRequest(`/appointments/${appointmentId}/cancel`, { method: 'POST', body, token }),
    onSettled: invalidate,
  });
}

/** As ações de desfecho da consulta (K2-b) e a rota de cada uma. */
export type OutcomeAction = 'attended' | 'no-show' | 'no-show/charge' | 'no-show/excuse' | 'no-show/excuse/revert';

/**
 * Registrar realização ou falta (depois do início), confirmar a cobrança da
 * falta, abonar ou reverter o abono (com motivo). O backend confere papel,
 * horário e estado; a tela só oferece a ação que vai funcionar.
 */
export function useAppointmentOutcomeAction() {
  const token = useAuthStore((s) => s.accessToken);
  const invalidate = useInvalidateAgenda();
  return useMutation({
    mutationFn: ({ appointmentId, action, reason }: { appointmentId: string; action: OutcomeAction; reason?: string }) =>
      apiRequest<Appointment>(`/appointments/${appointmentId}/${action}`, { method: 'POST', body: reason === undefined ? undefined : { reason }, token }),
    onSettled: invalidate,
  });
}
