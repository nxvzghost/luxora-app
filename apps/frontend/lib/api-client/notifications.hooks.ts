'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { useAuthStore } from '@/lib/stores/auth.store';

/**
 * notifications.hooks — Tarefa 05 da auditoria. As três rotas já existiam
 * (Epic 12, AD-021) e nenhuma tela as usava: a equipe nunca via o aviso.
 * Só o que a API já entrega — nenhum canal, destinatário ou regra nova.
 */
export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message: string;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

export function useNotifications() {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => apiRequest<{ data: NotificationItem[]; next_cursor: string | null }>('/notifications?limit=50', { token }),
    enabled: !!token,
  });
}

/** Contador do menu. Consultado de novo a cada minuto, enquanto a aba está aberta. */
export function useUnreadNotificationCount() {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['notifications-unread-count'],
    queryFn: () => apiRequest<{ count: number }>('/notifications/unread-count', { token }),
    enabled: !!token,
    refetchInterval: 60_000,
  });
}

export function useMarkNotificationRead() {
  const token = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (notificationId: string) => apiRequest<NotificationItem>(`/notifications/${notificationId}/read`, { method: 'POST', token }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notifications-unread-count'] });
    },
  });
}
