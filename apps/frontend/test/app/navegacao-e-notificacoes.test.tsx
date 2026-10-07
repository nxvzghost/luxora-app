import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithQueryClient } from '../support/render-with-query';
import { apiError, fakeToken, mockApi } from '../support/mock-api';
import { useAuthStore } from '@/lib/stores/auth.store';
import { SideNav } from '@/components/ui/side-nav';
import NotificacoesPage from '@/app/notificacoes/page';
import LoginPage from '@/app/(auth)/login/page';

/**
 * Tarefa 05 da auditoria — menu (perfil, contador de notificações, sair),
 * tela de notificações e os avisos da tela de login.
 */

const UNREAD = {
  id: 'n1',
  type: 'payment_divergent',
  title: 'Pagamento com valor divergente',
  message: 'O pagamento registrado não bate com o valor da cobrança.',
  entityType: 'payment',
  entityId: 'pay-1',
  readAt: null,
  createdAt: '2026-10-07T12:00:00.000Z',
};
const READ = { ...UNREAD, id: 'n2', title: 'Aviso já visto', readAt: '2026-10-06T10:00:00.000Z' };

function signIn(role: 'admin' | 'therapist') {
  useAuthStore.setState({ accessToken: fakeToken(role), refreshToken: 'refresh-1' });
}

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ accessToken: null, refreshToken: null, sessionExpired: false });
});

describe('SideNav', () => {
  it('admin vê todas as áreas, inclusive as que a API restringe a admin', async () => {
    signIn('admin');
    mockApi({ 'GET /notifications/unread-count': { body: { count: 0 } } });
    renderWithQueryClient(<SideNav />);

    for (const label of ['Agenda', 'Disponibilidade', 'Financeiro', 'Notificações', 'Usuários', 'Auditoria', 'Assinatura']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('terapeuta não vê Usuários, Auditoria nem Assinatura — rotas que responderiam "sem permissão"', () => {
    signIn('therapist');
    mockApi({ 'GET /notifications/unread-count': { body: { count: 0 } } });
    renderWithQueryClient(<SideNav />);

    expect(screen.getByRole('link', { name: 'Agenda' })).toBeInTheDocument();
    for (const label of ['Usuários', 'Auditoria', 'Assinatura']) {
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
    }
  });

  it('mostra quantas notificações não foram lidas', async () => {
    signIn('admin');
    mockApi({ 'GET /notifications/unread-count': { body: { count: 3 } } });
    renderWithQueryClient(<SideNav />);

    expect(await screen.findByLabelText('3 não lidas')).toBeInTheDocument();
  });

  it('uma única notificação não lida aparece no singular', async () => {
    signIn('admin');
    mockApi({ 'GET /notifications/unread-count': { body: { count: 1 } } });
    renderWithQueryClient(<SideNav />);

    expect(await screen.findByLabelText('1 não lida')).toBeInTheDocument();
  });

  it('"Sair" encerra a sessão local e revoga a sessão no servidor', async () => {
    signIn('admin');
    const api = mockApi({ 'GET /notifications/unread-count': { body: { count: 0 } }, 'POST /auth/logout': { status: 204 } });
    renderWithQueryClient(<SideNav />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sair' }));

    await waitFor(() => expect(api.sent('POST', '/auth/logout')).toHaveLength(1));
    expect(api.sent('POST', '/auth/logout')[0].body).toEqual({ refreshToken: 'refresh-1' });
    expect(useAuthStore.getState().accessToken).toBeNull();
  });
});

describe('NotificacoesPage', () => {
  it('lista as notificações, destacando as não lidas', async () => {
    signIn('admin');
    mockApi({ 'GET /notifications': { body: { data: [UNREAD, READ], next_cursor: null } } });
    renderWithQueryClient(<NotificacoesPage />);

    const unreadItem = (await screen.findByText('Pagamento com valor divergente')).closest('li') as HTMLElement;
    const readItem = screen.getByText('Aviso já visto').closest('li') as HTMLElement;

    expect(within(unreadItem).getByRole('button', { name: 'Marcar como lida' })).toBeInTheDocument();
    expect(within(readItem).queryByRole('button')).not.toBeInTheDocument();
    expect(within(readItem).getByText(/lida/)).toBeInTheDocument();
  });

  it('marcar como lida chama a API e atualiza a lista e o contador', async () => {
    signIn('admin');
    let read = false;
    const api = mockApi({
      'GET /notifications': () => ({ body: { data: [read ? { ...UNREAD, readAt: '2026-10-07T13:00:00.000Z' } : UNREAD], next_cursor: null } }),
      'GET /notifications/unread-count': () => ({ body: { count: read ? 0 : 1 } }),
      'POST /notifications/:id/read': () => {
        read = true;
        return { body: { ...UNREAD, readAt: '2026-10-07T13:00:00.000Z' } };
      },
    });
    renderWithQueryClient(<NotificacoesPage />);

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Marcar como lida' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Marcar como lida' })).not.toBeInTheDocument());
    expect(api.sent('POST', '/notifications/:id/read')[0].path).toBe('/notifications/n1/read');
    expect(api.sent('GET', '/notifications/unread-count').length).toBeGreaterThan(1);
  });

  it('sem notificações: diz que não há nada, sem parecer erro', async () => {
    signIn('admin');
    mockApi({ 'GET /notifications': { body: { data: [], next_cursor: null } } });
    renderWithQueryClient(<NotificacoesPage />);

    expect(await screen.findByText(/nenhuma notificação/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('assinatura inativa: explica o motivo em vez de "tente novamente"', async () => {
    signIn('admin');
    mockApi({ 'GET /notifications': apiError(403, 'SUBSCRIPTION_INACTIVE', 'Assinatura inativa.') });
    renderWithQueryClient(<NotificacoesPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/assinatura da clínica não está ativa/i);
    expect(screen.queryByText(/nenhuma notificação/i)).not.toBeInTheDocument();
  });
});

describe('LoginPage', () => {
  it('avisa quando a sessão anterior foi encerrada pelo servidor', () => {
    useAuthStore.setState({ sessionExpired: true });
    renderWithQueryClient(<LoginPage />);

    expect(screen.getByRole('status')).toHaveTextContent(/sessão foi encerrada/i);
  });

  it('sem sessão encerrada, não mostra aviso nenhum', () => {
    renderWithQueryClient(<LoginPage />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('senha errada mostra a frase do servidor; entrar guarda os tokens', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    mockApi({
      'POST /auth/login': () =>
        ++attempts === 1
          ? apiError(401, 'UNAUTHORIZED', 'Credenciais inválidas.')
          : { body: { accessToken: fakeToken('admin'), refreshToken: 'refresh-novo' } },
    });
    const { container } = renderWithQueryClient(<LoginPage />);
    await user.type(container.querySelector('input[type="email"]') as HTMLElement, 'admin@clinica.com');
    await user.type(container.querySelector('input[type="password"]') as HTMLElement, 'senha-errada-1');

    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Credenciais inválidas.');

    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(useAuthStore.getState().refreshToken).toBe('refresh-novo'));
  });

  it('muitas tentativas: pede para aguardar', async () => {
    const user = userEvent.setup();
    mockApi({ 'POST /auth/login': apiError(429, 'TOO_MANY_REQUESTS', 'ThrottlerException: Too Many Requests') });
    const { container } = renderWithQueryClient(<LoginPage />);
    await user.type(container.querySelector('input[type="email"]') as HTMLElement, 'admin@clinica.com');
    await user.type(container.querySelector('input[type="password"]') as HTMLElement, 'qualquer-senha');

    await user.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/aguarde um minuto/i);
  });
});
