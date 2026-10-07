'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { isNotFound } from '@/lib/api-client/errors';
import { useAuthStore } from '@/lib/stores/auth.store';
import type { Modality } from '@/lib/api-client/appointments.hooks';

/**
 * availability.hooks — Tarefa 05 da auditoria. Disponibilidade do
 * terapeuta: janelas semanais, exceções e bloqueios recorrentes. As rotas
 * de escrita já existiam; a de leitura do calendário entrou nesta tarefa.
 */
export interface AvailabilityWindow {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  sessionDurationMinutes: number;
}

export interface AvailabilityException {
  from: string;
  to: string;
  reason?: string;
}

export interface AvailabilityCalendar {
  therapistId: string;
  windows: AvailabilityWindow[];
  exceptions: AvailabilityException[];
}

export interface RecurringBlock {
  id: string;
  patientId: string;
  therapistId: string;
  firstOccurrence: string;
  intervalDays: number;
  modality: Modality;
  renewalMode: 'automatic' | 'manual';
}

/**
 * Calendário gravado. Terapeuta que ainda não tem um (404) volta como
 * calendário vazio: para a tela é "nada definido ainda", não um erro.
 */
export function useAvailabilityCalendar(therapistId: string) {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['availability-calendar', therapistId],
    queryFn: async (): Promise<AvailabilityCalendar> => {
      try {
        return await apiRequest<AvailabilityCalendar>(`/therapists/${therapistId}/availability/calendar`, { token });
      } catch (error) {
        if (isNotFound(error)) return { therapistId, windows: [], exceptions: [] };
        throw error;
      }
    },
    enabled: !!token && !!therapistId,
    retry: false,
  });
}

function useInvalidateAvailability(therapistId: string) {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ['availability-calendar', therapistId] });
    queryClient.invalidateQueries({ queryKey: ['availability-slots'] });
  };
}

/** PUT substitui TODAS as janelas do terapeuta pelas enviadas. */
export function useSetAvailabilityWindows(therapistId: string) {
  const token = useAuthStore((s) => s.accessToken);
  const invalidate = useInvalidateAvailability(therapistId);
  return useMutation({
    mutationFn: (windows: AvailabilityWindow[]) =>
      apiRequest<AvailabilityCalendar>(`/therapists/${therapistId}/availability`, { method: 'PUT', body: { windows }, token }),
    onSuccess: invalidate,
  });
}

/** PUT substitui TODAS as exceções do terapeuta pelas enviadas — quem chama manda a lista completa. */
export function useSetAvailabilityExceptions(therapistId: string) {
  const token = useAuthStore((s) => s.accessToken);
  const invalidate = useInvalidateAvailability(therapistId);
  return useMutation({
    mutationFn: (exceptions: AvailabilityException[]) =>
      apiRequest<AvailabilityCalendar>(`/therapists/${therapistId}/availability/exceptions`, { method: 'PUT', body: { exceptions }, token }),
    onSuccess: invalidate,
  });
}

export function useRecurringBlocks(therapistId: string) {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['recurring-blocks', therapistId],
    queryFn: () => apiRequest<{ data: RecurringBlock[] }>(`/recurring-blocks?therapistId=${therapistId}`, { token }),
    enabled: !!token && !!therapistId,
  });
}

export function useCreateRecurringBlock(therapistId: string) {
  const token = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { patientId: string; firstOccurrence: string; intervalDays: number; modality: Modality; renewalMode: 'automatic' | 'manual' }) =>
      apiRequest<RecurringBlock>('/recurring-blocks', { method: 'POST', body: { ...input, therapistId }, token }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recurring-blocks', therapistId] });
      queryClient.invalidateQueries({ queryKey: ['availability-slots'] });
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
    },
  });
}
