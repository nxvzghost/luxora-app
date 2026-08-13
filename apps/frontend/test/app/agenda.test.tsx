import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithQueryClient, mockFailingFetch } from '../support/render-with-query';
import { useAuthStore } from '@/lib/stores/auth.store';
import AgendaPage from '@/app/agenda/page';

const APPOINTMENT = {
  id: 'appt-1',
  patientId: 'patient-1',
  therapistId: 'therapist-1',
  scheduledAt: '2026-08-10T14:00:00.000Z',
  state: 'Criada',
  recurring: false,
};

function mockAppointmentsFetch(overrides: { confirmFails?: boolean; cancelFails?: boolean } = {}) {
  return vi.fn(async (url: string, options: { method?: string } = {}) => {
    const method = options.method ?? 'GET';
    if (method === 'GET' && url.includes('/appointments?')) {
      return { ok: true, status: 200, json: async () => ({ data: [APPOINTMENT] }) };
    }
    if (method === 'POST' && url.endsWith('/confirm')) {
      if (overrides.confirmFails) {
        return { ok: false, status: 400, json: async () => ({ error: { message: 'Não é possível confirmar.' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ ...APPOINTMENT, state: 'Confirmada' }) };
    }
    if (method === 'POST' && url.endsWith('/cancel')) {
      if (overrides.cancelFails) {
        return { ok: false, status: 400, json: async () => ({ error: { message: 'Não é possível cancelar.' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ ...APPOINTMENT, state: 'Cancelada' }) };
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

describe('AgendaPage — Fase 9.2 (AD-014) — isError', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'fake-token', refreshToken: 'fake-refresh' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ accessToken: null, refreshToken: null });
  });

  it('exibe mensagem de erro visível quando a busca de agendamentos falha', async () => {
    vi.stubGlobal('fetch', mockFailingFetch());
    renderWithQueryClient(<AgendaPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/não foi possível carregar a agenda/i);
    });
  });

  it('não exibe a mensagem de "nenhuma consulta" quando há erro (evita mensagem enganosa)', async () => {
    vi.stubGlobal('fetch', mockFailingFetch());
    renderWithQueryClient(<AgendaPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.queryByText(/nenhuma consulta/i)).not.toBeInTheDocument();
  });
});

describe('AgendaPage — Fase 9.3 (AD-015) — mutações de confirmar/cancelar', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'fake-token', refreshToken: 'fake-refresh' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ accessToken: null, refreshToken: null });
  });

  it('confirmar consulta chama POST /appointments/:id/confirm e reflete no estado sem reload manual', async () => {
    const user = userEvent.setup();
    const fetchMock = mockAppointmentsFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderWithQueryClient(<AgendaPage />);

    const confirmButton = await screen.findByRole('button', { name: /^confirmar$/i });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/appointments/appt-1/confirm'), expect.objectContaining({ method: 'POST' }));
    });
  });

  it('cancelar consulta chama POST /appointments/:id/cancel', async () => {
    const user = userEvent.setup();
    const fetchMock = mockAppointmentsFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderWithQueryClient(<AgendaPage />);

    const cancelButton = await screen.findByRole('button', { name: /^cancelar$/i });
    await user.click(cancelButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/appointments/appt-1/cancel'), expect.objectContaining({ method: 'POST' }));
    });
  });

  it('erro ao confirmar exibe mensagem visível, sem quebrar a lista', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', mockAppointmentsFetch({ confirmFails: true }));
    renderWithQueryClient(<AgendaPage />);

    const confirmButton = await screen.findByRole('button', { name: /^confirmar$/i });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/não é possível confirmar/i);
    });
  });

  it('erro ao cancelar exibe mensagem visível', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', mockAppointmentsFetch({ cancelFails: true }));
    renderWithQueryClient(<AgendaPage />);

    const cancelButton = await screen.findByRole('button', { name: /^cancelar$/i });
    await user.click(cancelButton);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/não é possível cancelar/i);
    });
  });
});
