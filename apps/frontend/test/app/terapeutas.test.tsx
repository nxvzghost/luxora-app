import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithQueryClient, mockFailingFetch } from '../support/render-with-query';
import { useAuthStore } from '@/lib/stores/auth.store';
import TerapeutasPage from '@/app/terapeutas/page';

const THERAPIST = { id: 'therapist-1', name: 'Dra. Ana Souza', specialty: 'Terapia Cognitivo-Comportamental' };

function mockTherapistsFetch(overrides: { createFails?: boolean } = {}) {
  let therapists = [THERAPIST];
  return vi.fn(async (url: string, options: { method?: string; body?: string } = {}) => {
    const method = options.method ?? 'GET';
    if (method === 'GET' && url.endsWith('/therapists')) {
      return { ok: true, status: 200, json: async () => ({ data: therapists }) };
    }
    if (method === 'POST' && url.endsWith('/therapists')) {
      if (overrides.createFails) {
        return { ok: false, status: 400, json: async () => ({ error: { message: 'Não é possível cadastrar.' } }) };
      }
      const input = JSON.parse(options.body ?? '{}');
      const created = { id: 'therapist-2', name: input.name, specialty: input.specialty ?? null };
      therapists = [...therapists, created];
      return { ok: true, status: 201, json: async () => created };
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

describe('TerapeutasPage — Fase 9.5 (AD-029) — listagem e erro', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'fake-token', refreshToken: 'fake-refresh' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ accessToken: null, refreshToken: null });
  });

  it('lista os terapeutas retornados pela API', async () => {
    vi.stubGlobal('fetch', mockTherapistsFetch());
    renderWithQueryClient(<TerapeutasPage />);

    expect(await screen.findByText('Dra. Ana Souza')).toBeInTheDocument();
    expect(screen.getByText('Terapia Cognitivo-Comportamental')).toBeInTheDocument();
  });

  it('exibe mensagem de erro visível quando a busca de terapeutas falha', async () => {
    vi.stubGlobal('fetch', mockFailingFetch());
    renderWithQueryClient(<TerapeutasPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/não foi possível carregar os terapeutas/i);
    });
  });

  it('não exibe "nenhum terapeuta cadastrado" quando há erro (evita mensagem enganosa)', async () => {
    vi.stubGlobal('fetch', mockFailingFetch());
    renderWithQueryClient(<TerapeutasPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.queryByText(/nenhum terapeuta cadastrado/i)).not.toBeInTheDocument();
  });
});

describe('TerapeutasPage — Fase 9.5 (AD-029) — criação', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'fake-token', refreshToken: 'fake-refresh' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ accessToken: null, refreshToken: null });
  });

  it('cadastra um terapeuta e a lista é invalidada/recarregada sem reload manual', async () => {
    const user = userEvent.setup();
    const fetchMock = mockTherapistsFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderWithQueryClient(<TerapeutasPage />);

    await screen.findByText('Dra. Ana Souza');

    await user.click(screen.getByRole('button', { name: /novo terapeuta/i }));
    await user.type(screen.getByPlaceholderText('Nome'), 'Dr. João Lima');
    await user.click(screen.getByRole('button', { name: /^cadastrar$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/therapists'), expect.objectContaining({ method: 'POST' }));
    });
    expect(await screen.findByText('Dr. João Lima')).toBeInTheDocument();
  });

  it('erro ao cadastrar exibe mensagem visível', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', mockTherapistsFetch({ createFails: true }));
    renderWithQueryClient(<TerapeutasPage />);

    await screen.findByText('Dra. Ana Souza');

    await user.click(screen.getByRole('button', { name: /novo terapeuta/i }));
    await user.type(screen.getByPlaceholderText('Nome'), 'Dr. João Lima');
    await user.click(screen.getByRole('button', { name: /^cadastrar$/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/não é possível cadastrar/i);
    });
  });
});
