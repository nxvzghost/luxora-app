'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { useAuthStore } from '@/lib/stores/auth.store';

export interface ClinicResponse {
  name: string;
  defaultBillingPolicy: 'per_session' | 'weekly' | 'monthly';
  cancellationHoursLimit: number | null;
  defaultSessionDurationMinutes: number;
  pixKey: string | null;
  payeeName: string | null;
}

export function useClinic() {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['clinic'],
    queryFn: () => apiRequest<ClinicResponse>('/clinic', { token }),
    enabled: !!token,
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
