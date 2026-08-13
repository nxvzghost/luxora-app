'use client';

import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { useAuthStore } from '@/lib/stores/auth.store';

/**
 * dashboard-summary.hooks — Epic 11 (AD-019). GET /dashboard/summary já
 * agrega no backend — nenhum filter/reduce client-side sobre listas cruas.
 */
export interface DashboardSummary {
  activePatients: number;
  overdueBillings: number;
  totalPending: number;
}

export function useDashboardSummary() {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['dashboard-summary'],
    queryFn: () => apiRequest<DashboardSummary>('/dashboard/summary', { token }),
    enabled: !!token,
  });
}
