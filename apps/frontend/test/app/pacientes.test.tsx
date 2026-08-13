import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithQueryClient, mockFailingFetch } from '../support/render-with-query';
import { useAuthStore } from '@/lib/stores/auth.store';
import PacientesPage from '@/app/pacientes/page';

describe('PacientesPage — Fase 9.2 (AD-014) — isError', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'fake-token', refreshToken: 'fake-refresh' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ accessToken: null, refreshToken: null });
  });

  it('exibe mensagem de erro visível quando a busca de pacientes falha', async () => {
    vi.stubGlobal('fetch', mockFailingFetch());
    renderWithQueryClient(<PacientesPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/não foi possível carregar os pacientes/i);
    });
  });

  it('não exibe "nenhum paciente cadastrado" quando há erro (evita mensagem enganosa)', async () => {
    vi.stubGlobal('fetch', mockFailingFetch());
    renderWithQueryClient(<PacientesPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.queryByText(/nenhum paciente cadastrado/i)).not.toBeInTheDocument();
  });
});
