'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { useAuthStore } from '@/lib/stores/auth.store';

export interface Patient {
  id: string;
  name: string;
  phone: string;
  state: string;
  billingPolicyOverride: string | null;
}

export interface Billing {
  id: string;
  patientId: string;
  amount: number;
  dueDate: string;
  state: string;
}

export function usePatients() {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['patients'],
    queryFn: () => apiRequest<{ data: Patient[] }>('/patients', { token }),
    enabled: !!token,
  });
}

export function useCreatePatient() {
  const token = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; phone: string }) =>
      apiRequest<Patient>('/patients', { method: 'POST', body: input, token }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['patients'] }),
  });
}

export function useBillings() {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['billings'],
    queryFn: () => apiRequest<{ data: Billing[] }>('/billings', { token }),
    enabled: !!token,
  });
}
