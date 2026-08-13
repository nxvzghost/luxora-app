'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { useAuthStore } from '@/lib/stores/auth.store';

/**
 * therapists.hooks — Fase 9.5 (AD-029). Endpoints já existentes —
 * GET/POST /therapists. `phone` é aceito na criação mas não é devolvido
 * pelo contrato de resposta do backend, por isso fica fora de `Therapist`.
 */
export interface Therapist {
  id: string;
  name: string;
  specialty: string | null;
}

export function useTherapists() {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['therapists'],
    queryFn: () => apiRequest<{ data: Therapist[] }>('/therapists', { token }),
    enabled: !!token,
  });
}

export function useCreateTherapist() {
  const token = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; specialty?: string }) =>
      apiRequest<Therapist>('/therapists', { method: 'POST', body: input, token }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['therapists'] }),
  });
}
