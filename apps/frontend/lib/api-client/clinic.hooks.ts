'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { useAuthStore } from '@/lib/stores/auth.store';
import { isKnownTimeZone } from '@/lib/clinic-time';

export interface ClinicResponse {
  name: string;
  defaultBillingPolicy: 'per_session' | 'weekly' | 'monthly';
  cancellationHoursLimit: number | null;
  defaultSessionDurationMinutes: number;
  pixKey: string | null;
  payeeName: string | null;
  /** AD-039 — o fuso em que a agenda e os vencimentos da clínica valem (nome da base IANA). */
  timeZone: string;
}

export function useClinic() {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['clinic'],
    queryFn: () => apiRequest<ClinicResponse>('/clinic', { token }),
    enabled: !!token,
  });
}

/**
 * AD-039 (ADR-0064) — o fuso em que o painel mostra e lê horários: o da
 * clínica, não o do computador.
 *
 * `timeZone` fica indefinido enquanto a clínica não foi lida, e também se a
 * leitura falhar ou trouxer um fuso que este navegador não conhece. Nesses
 * casos as telas usam o fuso do computador — e `unavailable` diz a elas para
 * avisar, em vez de mostrar em silêncio um horário que pode não ser o da
 * clínica (ver `ClinicTimeZoneNote`).
 */
export function useClinicTimeZone(): { timeZone: string | undefined; unavailable: boolean } {
  const { data, isError } = useClinic();
  const known = isKnownTimeZone(data?.timeZone);
  return { timeZone: known ? data?.timeZone : undefined, unavailable: isError || (data !== undefined && !known) };
}

/** AD-039 — só admin. O fuso muda a hora de toda a agenda e o dia dos vencimentos: tudo o que a tela já leu é relido. */
export function useUpdateClinicTimeZone() {
  const token = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (timeZone: string) => apiRequest<ClinicResponse>('/clinic/time-zone', { method: 'PUT', body: { timeZone }, token }),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

export function useUpdateClinicPolicies() {
  const token = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      defaultBillingPolicy?: string;
      cancellationHoursLimit?: number;
      defaultSessionDurationMinutes?: number;
    }) => apiRequest<ClinicResponse>('/clinic/policies', { method: 'PUT', body: input, token }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['clinic'] }),
  });
}

export function useUpdatePaymentInfo() {
  const token = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { pixKey?: string; payeeName?: string }) =>
      apiRequest<ClinicResponse>('/clinic/payment-info', { method: 'PUT', body: input, token }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['clinic'] }),
  });
}
