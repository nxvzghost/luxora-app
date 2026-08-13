'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { useAuthStore } from '@/lib/stores/auth.store';

/**
 * billing.hooks — Fase 9.4 (AD-020). Endpoints já existentes e já
 * protegidos por RBAC (admin) — POST billings/:id/send, POST payments.
 *
 * "Criar cobrança" e "estorno" ficam fora de escopo desta subfase —
 * ver achado arquitetural registrado no relatório de fechamento da Fase
 * 9.4 (ausência de endpoint de descoberta de sessões faturáveis e de
 * listagem de pagamentos).
 */
export function useSendBilling() {
  const token = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (billingId: string) => apiRequest(`/billings/${billingId}/send`, { method: 'POST', token }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['billings'] }),
  });
}

export function useRegisterPayment() {
  const token = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ billingId, amount }: { billingId: string; amount: number }) =>
      apiRequest('/payments', {
        method: 'POST',
        token,
        body: { billingId, amount },
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['billings'] }),
  });
}
