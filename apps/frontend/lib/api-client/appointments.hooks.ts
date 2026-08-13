'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { useAuthStore } from '@/lib/stores/auth.store';

/**
 * appointments.hooks — Fase 9.3 (AD-015). Endpoints já existentes e já
 * protegidos por RBAC (admin+therapist, Epic 3 Etapa 5) — POST
 * appointments/:id/confirm e POST appointments/:id/cancel, sem corpo.
 */
export function useConfirmAppointment() {
  const token = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (appointmentId: string) => apiRequest(`/appointments/${appointmentId}/confirm`, { method: 'POST', token }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['appointments-today'] }),
  });
}

export function useCancelAppointment() {
  const token = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (appointmentId: string) => apiRequest(`/appointments/${appointmentId}/cancel`, { method: 'POST', token }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['appointments-today'] }),
  });
}
