'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { fetchAllPages } from '@/lib/api-client/pagination';
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
  /** Estado do pagamento da cobrança, ou null quando não há pagamento. Só vem na lista (GET /billings). */
  paymentState?: string | null;
}

/** Todos os pacientes da clínica — a API pagina; ver fetchAllPages. */
export function usePatients() {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['patients'],
    queryFn: () => fetchAllPages<Patient>('/patients', token),
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

/** Todas as cobranças da clínica — os totais do Financeiro são somados a partir desta lista. */
export function useBillings() {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['billings'],
    queryFn: () => fetchAllPages<Billing>('/billings', token),
    enabled: !!token,
  });
}
