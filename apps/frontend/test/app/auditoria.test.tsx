import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithQueryClient, mockFailingFetch } from '../support/render-with-query';
import { useAuthStore } from '@/lib/stores/auth.store';
import AuditoriaPage from '@/app/auditoria/page';

const ENTRY = {
  id: 'audit-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
  actorType: 'user' as const,
  action: 'billing.send',
  entityType: 'Billing',
  entityId: 'billing-1',
  payload: { billingId: 'billing-1' },
  result: 'success' as const,
};

function mockAuditFetch() {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/audit-log')) {
      return { ok: true, status: 200, json: async () => ({ data: [ENTRY] }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe('AuditoriaPage — Fase 9.5 (AD-029) — listagem, erro e payload', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'fake-token', refreshToken: 'fake-refresh' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ accessToken: null, refreshToken: null });
  });

  it('lista os registros de auditoria retornados pela API', async () => {
    vi.stubGlobal('fetch', mockAuditFetch());
    renderWithQueryClient(<AuditoriaPage />);

    expect(await screen.findByText('billing.send')).toBeInTheDocument();
    expect(screen.getByText(/Billing \(billing-1\)/)).toBeInTheDocument();
  });

  it('renderiza o payload como JSON formatado', async () => {
    vi.stubGlobal('fetch', mockAuditFetch());
    renderWithQueryClient(<AuditoriaPage />);

    await screen.findByText('billing.send');
    expect(screen.getByText(/"billingId": "billing-1"/)).toBeInTheDocument();
  });

  it('exibe mensagem de erro visível quando a busca de auditoria falha', async () => {
    vi.stubGlobal('fetch', mockFailingFetch());
    renderWithQueryClient(<AuditoriaPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/não foi possível carregar a auditoria/i);
    });
  });

  it('não exibe "nenhum registro de auditoria" quando há erro (evita mensagem enganosa)', async () => {
    vi.stubGlobal('fetch', mockFailingFetch());
    renderWithQueryClient(<AuditoriaPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.queryByText(/nenhum registro de auditoria/i)).not.toBeInTheDocument();
  });
});
