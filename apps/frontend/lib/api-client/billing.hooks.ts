'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { useAuthStore } from '@/lib/stores/auth.store';
import type { Billing } from '@/lib/api-client/dashboard.hooks';

/**
 * billing.hooks — Fase 9.4 (AD-020), completado na Tarefa 05 da auditoria.
 *
 * "Criar cobrança" e "estorno" tinham ficado de fora porque a API não
 * permitia descobrir as sessões a cobrar nem o pagamento de uma cobrança.
 * As duas rotas de leitura entraram nesta tarefa (GET /sessions e
 * GET /billings/:id/payments) e as telas passaram a usá-las. Todas as
 * rotas de escrita são só de admin, como já eram.
 */
export interface BillableSession {
  id: string;
  appointmentId: string;
  patientId: string;
  therapistId: string;
  state: string;
  scheduledAt: string;
}

export interface Payment {
  id: string;
  billingId: string;
  amount: number;
  state: string;
}

function useInvalidateFinance() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of ['billings', 'sessions', 'billing-payments', 'dashboard-summary', 'notifications', 'notifications-unread-count']) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
}

/** Sessões realizadas e ainda não cobradas de um paciente — o que pode entrar numa cobrança nova. */
export function useBillableSessions(patientId: string) {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['sessions', 'Realizada', patientId],
    queryFn: () => apiRequest<{ data: BillableSession[] }>(`/sessions?state=Realizada&patientId=${patientId}`, { token }),
    enabled: !!token && !!patientId,
  });
}

export function useCreateBilling() {
  const token = useAuthStore((s) => s.accessToken);
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: (input: { patientId: string; amount: number; dueDate: string; sessionIds: string[] }) =>
      apiRequest<Billing>('/billings', { method: 'POST', body: input, token }),
    onSettled: invalidate,
  });
}

export function useSendBilling() {
  const token = useAuthStore((s) => s.accessToken);
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: (billingId: string) => apiRequest(`/billings/${billingId}/send`, { method: 'POST', token }),
    onSuccess: invalidate,
  });
}

/** O pagamento de uma cobrança (a API guarda no máximo um). */
export function useBillingPayments(billingId: string | null) {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['billing-payments', billingId],
    queryFn: () => apiRequest<{ data: Payment[] }>(`/billings/${billingId}/payments`, { token }),
    enabled: !!token && !!billingId,
    staleTime: 0,
  });
}

/**
 * A chave de idempotência nasce com a tela de confirmação e é a mesma em
 * toda tentativa daquele registro: se a resposta se perder e a pessoa
 * clicar de novo, o servidor devolve o pagamento já criado em vez de
 * tentar outro (RNF-008).
 */
export function useRegisterPayment() {
  const token = useAuthStore((s) => s.accessToken);
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: ({ billingId, amount, idempotencyKey }: { billingId: string; amount: number; idempotencyKey: string }) =>
      apiRequest<Payment>('/payments', {
        method: 'POST',
        token,
        body: { billingId, amount },
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    onSettled: invalidate,
  });
}

export function useRefundPayment() {
  const token = useAuthStore((s) => s.accessToken);
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: (paymentId: string) => apiRequest<Payment>(`/payments/${paymentId}/refund`, { method: 'POST', token }),
    onSettled: invalidate,
  });
}
