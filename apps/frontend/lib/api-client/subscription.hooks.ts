'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { useAuthStore } from '@/lib/stores/auth.store';

export type PlanTier = 'professional' | 'business' | 'enterprise';
export type BillingCycle = 'monthly' | 'yearly';

interface SubscriptionResponse {
  plan: PlanTier;
  billingCycle: BillingCycle;
  status: 'Trialing' | 'Active' | 'PastDue' | 'Cancelled';
  amountPerCycle: number;
}

export function useSubscription() {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['subscription'],
    queryFn: () => apiRequest<SubscriptionResponse>('/subscription', { token }),
    enabled: !!token,
    retry: false,
  });
}

export function useCreateSubscription() {
  const token = useAuthStore((s) => s.accessToken);
  return useMutation({
    mutationFn: (input: {
      plan: PlanTier;
      billingCycle: BillingCycle;
      clinicName: string;
      clinicEmail: string;
      clinicCpfCnpj: string;
      billingType: 'CREDIT_CARD' | 'PIX';
    }) => apiRequest<SubscriptionResponse>('/subscription', { method: 'POST', body: input, token }),
  });
}

export function useAttachCreditCard() {
  const token = useAuthStore((s) => s.accessToken);
  return useMutation({
    mutationFn: (input: {
      holderName: string;
      number: string;
      expiryMonth: string;
      expiryYear: string;
      ccv: string;
      holderEmail: string;
      holderCpfCnpj: string;
    }) => apiRequest<{ status: string }>('/subscription/credit-card', { method: 'POST', body: input, token }),
  });
}
