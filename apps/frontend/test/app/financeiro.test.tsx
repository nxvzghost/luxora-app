import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithQueryClient, mockFailingFetch } from '../support/render-with-query';
import { useAuthStore } from '@/lib/stores/auth.store';
import FinanceiroPage from '@/app/financeiro/page';

const BILLING = {
  id: 'billing-1',
  patientId: 'patient-1',
  amount: 200,
  dueDate: '2026-08-10T00:00:00.000Z',
  state: 'Criada',
};

function mockFinanceiroFetch(overrides: { sendFails?: boolean; paymentFails?: boolean; billingState?: string } = {}) {
  const billing = { ...BILLING, state: overrides.billingState ?? BILLING.state };
  return vi.fn(async (url: string, options: { method?: string; headers?: Record<string, string> } = {}) => {
    const method = options.method ?? 'GET';
    if (method === 'GET' && url.includes('/billings')) {
      return { ok: true, status: 200, json: async () => ({ data: [billing] }) };
    }
    if (method === 'GET' && url.includes('/patients')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'patient-1', name: 'Paciente Teste', phone: '+5541900000000', state: 'Ativo', billingPolicyOverride: null }] }) };
    }
    if (method === 'POST' && url.endsWith('/send')) {
      if (overrides.sendFails) {
        return { ok: false, status: 400, json: async () => ({ error: { message: 'Não é possível enviar.' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ ...billing, state: 'Enviada' }) };
    }
    if (method === 'POST' && url.endsWith('/payments')) {
      if (overrides.paymentFails) {
        return { ok: false, status: 400, json: async () => ({ error: { message: 'Não é possível registrar o pagamento.' } }) };
      }
      return { ok: true, status: 201, json: async () => ({ id: 'payment-1', billingId: billing.id, amount: billing.amount, state: 'Confirmado' }) };
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

describe('FinanceiroPage — Fase 9.2 (AD-014) — isError', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'fake-token', refreshToken: 'fake-refresh' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ accessToken: null, refreshToken: null });
  });

  it('exibe mensagem de erro visível quando a busca de cobranças falha', async () => {
    vi.stubGlobal('fetch', mockFailingFetch());
    renderWithQueryClient(<FinanceiroPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/não foi possível carregar os dados financeiros/i);
    });
  });

  it('não exibe "nenhuma cobrança gerada" quando há erro (evita mensagem enganosa)', async () => {
    vi.stubGlobal('fetch', mockFailingFetch());
    renderWithQueryClient(<FinanceiroPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.queryByText(/nenhuma cobrança gerada/i)).not.toBeInTheDocument();
  });
});

describe('FinanceiroPage — Fase 9.4 (AD-020) — mutações de enviar/registrar pagamento', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'fake-token', refreshToken: 'fake-refresh' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ accessToken: null, refreshToken: null });
  });

  it('cobrança em estado Criada mostra os botões Enviar e Registrar pagamento', async () => {
    vi.stubGlobal('fetch', mockFinanceiroFetch({ billingState: 'Criada' }));
    renderWithQueryClient(<FinanceiroPage />);

    expect(await screen.findByRole('button', { name: /^enviar$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /registrar pagamento/i })).toBeInTheDocument();
  });

  it('cobrança em estado Quitada não mostra nenhum botão de ação', async () => {
    vi.stubGlobal('fetch', mockFinanceiroFetch({ billingState: 'Quitada' }));
    renderWithQueryClient(<FinanceiroPage />);

    await screen.findByText('Paciente Teste');
    expect(screen.queryByRole('button', { name: /^enviar$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /registrar pagamento/i })).not.toBeInTheDocument();
  });

  it('enviar cobrança chama POST /billings/:id/send', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFinanceiroFetch({ billingState: 'Criada' });
    vi.stubGlobal('fetch', fetchMock);
    renderWithQueryClient(<FinanceiroPage />);

    const sendButton = await screen.findByRole('button', { name: /^enviar$/i });
    await user.click(sendButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/billings/billing-1/send'), expect.objectContaining({ method: 'POST' }));
    });
  });

  it('registrar pagamento chama POST /payments com header Idempotency-Key e o valor total da cobrança', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFinanceiroFetch({ billingState: 'Pendente' });
    vi.stubGlobal('fetch', fetchMock);
    renderWithQueryClient(<FinanceiroPage />);

    const payButton = await screen.findByRole('button', { name: /registrar pagamento/i });
    await user.click(payButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/payments'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ billingId: 'billing-1', amount: 200 }),
          headers: expect.objectContaining({ 'Idempotency-Key': expect.any(String) }),
        }),
      );
    });
  });

  it('erro ao enviar exibe mensagem visível', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', mockFinanceiroFetch({ billingState: 'Criada', sendFails: true }));
    renderWithQueryClient(<FinanceiroPage />);

    const sendButton = await screen.findByRole('button', { name: /^enviar$/i });
    await user.click(sendButton);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/não é possível enviar/i);
    });
  });

  it('erro ao registrar pagamento exibe mensagem visível', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', mockFinanceiroFetch({ billingState: 'Pendente', paymentFails: true }));
    renderWithQueryClient(<FinanceiroPage />);

    const payButton = await screen.findByRole('button', { name: /registrar pagamento/i });
    await user.click(payButton);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/não é possível registrar o pagamento/i);
    });
  });
});
