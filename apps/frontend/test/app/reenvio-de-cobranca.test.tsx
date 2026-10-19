import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithQueryClient } from '../support/render-with-query';
import { apiError, fakeToken, mockApi } from '../support/mock-api';
import { useAuthStore } from '@/lib/stores/auth.store';
import NotificacoesPage from '@/app/notificacoes/page';

/** ADR-0066 — o aviso de falha de envio de uma cobrança traz o botão de reenviar. */
const FAILED = {
  id: 'n-falha',
  type: 'whatsapp_send_failed',
  title: 'WhatsApp: mensagem não enviada',
  message: 'A cobrança para o número com final 1234 não foi enviada: a credencial do WhatsApp da clínica foi recusada.',
  entityType: 'Billing',
  entityId: 'billing-1',
  readAt: null,
  createdAt: '2026-10-19T12:00:00.000Z',
};
const OTHER = { ...FAILED, id: 'n-outro', type: 'payment_divergent', title: 'Pagamento com valor divergente', entityType: 'payment', entityId: 'pay-1' };

function signIn(role: 'admin' | 'therapist') {
  useAuthStore.setState({ accessToken: fakeToken(role), refreshToken: 'refresh-1' });
}

const item = (title: string) => screen.getByText(title).closest('li') as HTMLElement;

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ accessToken: null, refreshToken: null, sessionExpired: false });
});

describe('NotificacoesPage — reenviar cobrança (ADR-0066)', () => {
  it('administrador: o botão aparece só no aviso de falha de cobrança ainda não lido', async () => {
    signIn('admin');
    const read = { ...FAILED, id: 'n-lida', title: 'Aviso de falha já tratado', readAt: '2026-10-19T13:00:00.000Z' };
    mockApi({ 'GET /notifications': { body: { data: [FAILED, OTHER, read], next_cursor: null } } });
    renderWithQueryClient(<NotificacoesPage />);

    await screen.findByText('WhatsApp: mensagem não enviada');
    expect(within(item('WhatsApp: mensagem não enviada')).getByRole('button', { name: 'Reenviar cobrança' })).toBeInTheDocument();
    expect(within(item('Pagamento com valor divergente')).queryByRole('button', { name: 'Reenviar cobrança' })).not.toBeInTheDocument();
    expect(within(item('Aviso de falha já tratado')).queryByRole('button', { name: 'Reenviar cobrança' })).not.toBeInTheDocument();
  });

  it('terapeuta: não vê o botão (a API só aceita do administrador)', async () => {
    signIn('therapist');
    mockApi({ 'GET /notifications': { body: { data: [FAILED], next_cursor: null } } });
    renderWithQueryClient(<NotificacoesPage />);
    await screen.findByText('WhatsApp: mensagem não enviada');
    expect(screen.queryByRole('button', { name: 'Reenviar cobrança' })).not.toBeInTheDocument();
  });

  it('pede confirmação dizendo o que acontece; confirmar chama a API com a cobrança do aviso e mostra o resultado', async () => {
    signIn('admin');
    const user = userEvent.setup();
    let resent = false;
    const api = mockApi({
      'GET /notifications': () => ({ body: { data: [resent ? { ...FAILED, readAt: '2026-10-19T14:00:00.000Z' } : FAILED], next_cursor: null } }),
      'GET /notifications/unread-count': () => ({ body: { count: resent ? 0 : 1 } }),
      'POST /billings/:id/resend': () => {
        resent = true;
        return { status: 201, body: { id: 'billing-1', state: 'Enviada' } };
      },
    });
    renderWithQueryClient(<NotificacoesPage />);

    await user.click(await screen.findByRole('button', { name: 'Reenviar cobrança' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('janela de 24 horas');
    expect(api.sent('POST', '/billings/:id/resend')).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Reenviar' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Cobrança reenviada.');
    expect(api.sent('POST', '/billings/:id/resend')[0].path).toBe('/billings/billing-1/resend');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reenviar cobrança' })).not.toBeInTheDocument());
  });

  it('recusa da API: o motivo aparece na confirmação e o aviso continua com o botão', async () => {
    signIn('admin');
    const user = userEvent.setup();
    mockApi({
      'GET /notifications': { body: { data: [FAILED], next_cursor: null } },
      'POST /billings/:id/resend': apiError(409, 'CONFLICT', 'Só uma cobrança já enviada e ainda não paga pode ser reenviada.'),
    });
    renderWithQueryClient(<NotificacoesPage />);

    await user.click(await screen.findByRole('button', { name: 'Reenviar cobrança' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reenviar' }));

    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('Só uma cobrança já enviada e ainda não paga');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
