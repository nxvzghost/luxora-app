'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { useAuthStore } from '@/lib/stores/auth.store';

/**
 * appointments.hooks — Fase 9.3 (AD-015) e Tarefa 05 da auditoria.
 * Todas as rotas já existiam e já são protegidas por RBAC (admin e
 * therapist): o que faltava era a tela usá-las para criar e remarcar.
 */
export interface Appointment {
  id: string;
  patientId: string;
  therapistId: string;
  scheduledAt: string;
  state: string;
  recurring: boolean;
}

export interface AvailableSlot {
  startsAt: string;
  endsAt: string;
}

export type Modality = 'presencial' | 'online';

/** Consultas de um intervalo. A API não devolve as canceladas. */
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

function useInvalidateAgenda() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ['appointments'] });
    queryClient.invalidateQueries({ queryKey: ['availability-slots'] });
    // Confirmar uma consulta cria a sessão que depois será cobrada.
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

export function useRescheduleAppointment() {
  const token = useAuthStore((s) => s.accessToken);
  const invalidate = useInvalidateAgenda();
  return useMutation({
    mutationFn: ({ appointmentId, newScheduledAt }: { appointmentId: string; newScheduledAt: string }) =>
      apiRequest<Appointment>(`/appointments/${appointmentId}/reschedule`, { method: 'PATCH', body: { newScheduledAt }, token }),
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
    mutationFn: (appointmentId: string) => apiRequest(`/appointments/${appointmentId}/cancel`, { method: 'POST', token }),
    onSettled: invalidate,
  });
}
