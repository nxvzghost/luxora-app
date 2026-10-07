'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { useAuthStore } from '@/lib/stores/auth.store';
import type { Role } from '@/lib/session';

/**
 * users.hooks — Tarefa 05 da auditoria. A gestão de usuários existia só na
 * API (Epic 5): dar acesso a um terapeuta exigia chamá-la direto. Todas as
 * rotas de escrita são só de admin.
 */
export interface ClinicUser {
  id: string;
  email: string;
  role: Role;
  therapistId: string | null;
  isActive: boolean;
}

export function useUsers(enabled = true) {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['users'],
    queryFn: () => apiRequest<{ data: ClinicUser[] }>('/users', { token }),
    enabled: !!token && enabled,
  });
}

function useUserMutation<TInput>(request: (input: TInput, token: string | null) => Promise<ClinicUser>) {
  const token = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => request(input, token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });
}

/** `therapistId` acompanha o papel "therapist" e nunca o papel "admin" — é a regra do backend. */
export function useCreateUser() {
  return useUserMutation((input: { email: string; password: string; role: Role; therapistId?: string }, token) =>
    apiRequest<ClinicUser>('/users', { method: 'POST', body: input, token }),
  );
}

export function useDeactivateUser() {
  return useUserMutation((id: string, token) => apiRequest<ClinicUser>(`/users/${id}/deactivate`, { method: 'POST', token }));
}

export function useReactivateUser() {
  return useUserMutation((id: string, token) => apiRequest<ClinicUser>(`/users/${id}/reactivate`, { method: 'POST', token }));
}
