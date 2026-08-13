import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

export function mockFailingFetch() {
  return vi.fn().mockResolvedValue({
    ok: false,
    status: 500,
    json: async () => ({ error: { message: 'erro simulado', code: 'SIMULATED', category: 'system' } }),
  });
}
