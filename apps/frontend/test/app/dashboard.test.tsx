import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithQueryClient, mockFailingFetch } from '../support/render-with-query';
import { useAuthStore } from '@/lib/stores/auth.store';
import DashboardPage from '@/app/dashboard/page';

const SUMMARY = { activePatients: 4, overdueBillings: 2, totalPending: 1600 };
const PATIENT = { id: 'patient-1', name: 'Paciente Teste', phone: '+5541900000000', state: 'Ativo', billingPolicyOverride: null };

function mockDashboardFetch() {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/dashboard/summary')) {
      return { ok: true, status: 200, json: async () => SUMMARY };
    }
    if (url.includes('/patients')) {
      return { ok: true, status: 200, json: async () => ({ data: [PATIENT] }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe('DashboardPage — Fase 9.2 (AD-014) — isError', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'fake-token', refreshToken: 'fake-refresh' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ accessToken: null, refreshToken: null });
  });

  it('exibe mensagem de erro visível quando a busca de pacientes/cobranças falha', async () => {
    vi.stubGlobal('fetch', mockFailingFetch());
    renderWithQueryClient(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/não foi possível carregar todos os dados/i);
    });
  });

  it('não exibe "nenhum paciente cadastrado" quando há erro (evita mensagem enganosa)', async () => {
    vi.stubGlobal('fetch', mockFailingFetch());
    renderWithQueryClient(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.queryByText(/nenhum paciente cadastrado/i)).not.toBeInTheDocument();
  });
});

describe('DashboardPage — Epic 11 (AD-019) — GET /dashboard/summary', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'fake-token', refreshToken: 'fake-refresh' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ accessToken: null, refreshToken: null });
  });

  it('renderiza os três indicadores vindos de GET /dashboard/summary', async () => {
    vi.stubGlobal('fetch', mockDashboardFetch());
    renderWithQueryClient(<DashboardPage />);

    expect(await screen.findByText('4')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/1\.600,00/)).toBeInTheDocument();
  });

  it('chama GET /dashboard/summary e nunca GET /billings', async () => {
    const fetchMock = mockDashboardFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderWithQueryClient(<DashboardPage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/dashboard/summary'), expect.anything());
    });
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/billings'), expect.anything());
  });

  it('"Pacientes recentes" continua renderizando via /patients, independente do summary', async () => {
    vi.stubGlobal('fetch', mockDashboardFetch());
    renderWithQueryClient(<DashboardPage />);

    expect(await screen.findByText('Paciente Teste')).toBeInTheDocument();
  });
});
