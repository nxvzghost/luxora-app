'use client';

import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { useAuthStore } from '@/lib/stores/auth.store';

/**
 * audit.hooks — Fase 9.5 (AD-029). Somente leitura — GET /audit-log
 * (`@Roles('admin')`). Sem paginação por cursor/filtros nesta subfase.
 * AuditLogEntry não possui campo de data/hora — limitação do contrato.
 */
export interface AuditLogEntry {
  id: string;
  tenantId: string;
  userId: string | null;
  actorType: 'user' | 'ai_agent' | 'system';
  action: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown> | null;
  result: 'success' | 'failure';
}

export function useAuditLog() {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['audit-log'],
    queryFn: () => apiRequest<{ data: AuditLogEntry[] }>('/audit-log', { token }),
    enabled: !!token,
  });
}
