import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithQueryClient } from '../support/render-with-query';
import { apiError, mockApi, type MockReply, type MockRequest } from '../support/mock-api';
import { useAuthStore } from '@/lib/stores/auth.store';
import UsuariosPage from '@/app/usuarios/page';
import { WhatsAppConnection } from '@/components/whatsapp-connection';
import { OnboardingChecklist } from '@/components/onboarding-checklist';

/**
 * Tarefa 05 da auditoria — preparar a clínica para o uso: usuários da
 * equipe, conexão do WhatsApp e a lista de primeiros passos.
 */

const ME = { id: 'user-me', email: 'admin@clinica.com', role: 'admin', therapistId: null, isActive: true };
const THERAPIST_USER = { id: 'user-2', email: 'marta@clinica.com', role: 'therapist', therapistId: 't1', isActive: true };
const INACTIVE = { id: 'user-3', email: 'antigo@clinica.com', role: 'therapist', therapistId: 't1', isActive: false };

type Routes = Record<string, MockReply | ((request: MockRequest) => MockReply)>;

function tokenFor(role: 'admin' | 'therapist', sub = 'user-me') {
  return `h.${btoa(JSON.stringify({ sub, tenantId: 't', role }))}.s`;
}

function signIn(role: 'admin' | 'therapist' = 'admin') {
  useAuthStore.setState({ accessToken: tokenFor(role), refreshToken: 'refresh' });
}

function mockUsers(overrides: Routes = {}) {
  return mockApi({
    'GET /users': { body: { data: [ME, THERAPIST_USER, INACTIVE] } },
    'GET /therapists': { body: { data: [{ id: 't1', name: 'Dra. Marta', specialty: null }] } },
    'GET /notifications/unread-count': { body: { count: 0 } },
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ accessToken: null, refreshToken: null });
});

describe('UsuariosPage', () => {
  it('lista quem tem acesso, com perfil, terapeuta vinculado e quem está sem acesso', async () => {
    signIn();
    mockUsers();
    renderWithQueryClient(<UsuariosPage />);

    const mine = (await screen.findByText(/admin@clinica\.com/)).closest('li') as HTMLElement;
    const therapist = screen.getByText('marta@clinica.com').closest('li') as HTMLElement;
    const inactive = screen.getByText('antigo@clinica.com').closest('li') as HTMLElement;

    expect(mine).toHaveTextContent(/\(você\)/);
    expect(mine).toHaveTextContent('Administrador');
    expect(therapist).toHaveTextContent(/Terapeuta · Dra\. Marta/);
    expect(inactive).toHaveTextContent(/sem acesso/);
  });

  it('não oferece desativar o próprio usuário — ninguém se tranca para fora', async () => {
    signIn();
    mockUsers();
    renderWithQueryClient(<UsuariosPage />);

    const mine = (await screen.findByText(/admin@clinica\.com/)).closest('li') as HTMLElement;
    expect(within(mine).queryByRole('button', { name: 'Desativar' })).not.toBeInTheDocument();
    expect(within(screen.getByText('marta@clinica.com').closest('li') as HTMLElement).getByRole('button', { name: 'Desativar' })).toBeInTheDocument();
  });

  it('criar acesso de terapeuta envia o terapeuta vinculado', async () => {
    signIn();
    const user = userEvent.setup();
    const api = mockUsers({ 'POST /users': { status: 201, body: { ...THERAPIST_USER, id: 'user-novo', email: 'novo@clinica.com' } } });
    renderWithQueryClient(<UsuariosPage />);

    await user.click(await screen.findByRole('button', { name: 'Novo usuário' }));
    const form = screen.getByRole('form', { name: 'Novo usuário' });
    await waitFor(() => expect(within(form).getByRole('option', { name: 'Dra. Marta' })).toBeInTheDocument());
    await user.type(within(form).getByLabelText('E-mail'), 'novo@clinica.com');
    await user.type(within(form).getByLabelText('Senha inicial'), 'senha-forte-1');
    await user.selectOptions(within(form).getByLabelText('Terapeuta vinculado'), 't1');
    await user.click(within(form).getByRole('button', { name: 'Criar usuário' }));

    await waitFor(() => expect(api.sent('POST', '/users')).toHaveLength(1));
    expect(api.sent('POST', '/users')[0].body).toEqual({ email: 'novo@clinica.com', password: 'senha-forte-1', role: 'therapist', therapistId: 't1' });
    expect(await screen.findByRole('status')).toHaveTextContent(/acesso criado para novo@clinica\.com/i);
  });

  it('criar administrador não envia terapeuta vinculado (o backend recusa a combinação)', async () => {
    signIn();
    const user = userEvent.setup();
    const api = mockUsers({ 'POST /users': { status: 201, body: { ...ME, id: 'user-novo', email: 'socio@clinica.com' } } });
    renderWithQueryClient(<UsuariosPage />);

    await user.click(await screen.findByRole('button', { name: 'Novo usuário' }));
    const form = screen.getByRole('form', { name: 'Novo usuário' });
    await user.type(within(form).getByLabelText('E-mail'), 'socio@clinica.com');
    await user.type(within(form).getByLabelText('Senha inicial'), 'senha-forte-1');
    await user.selectOptions(within(form).getByLabelText('Perfil'), 'admin');
    expect(within(form).queryByLabelText('Terapeuta vinculado')).not.toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Criar usuário' }));

    await waitFor(() => expect(api.sent('POST', '/users')).toHaveLength(1));
    expect(api.sent('POST', '/users')[0].body).toEqual({ email: 'socio@clinica.com', password: 'senha-forte-1', role: 'admin' });
  });

  it('terapeuta sem vínculo escolhido: barra na tela, sem chamar a API', async () => {
    signIn();
    const user = userEvent.setup();
    const api = mockUsers();
    renderWithQueryClient(<UsuariosPage />);

    await user.click(await screen.findByRole('button', { name: 'Novo usuário' }));
    const form = screen.getByRole('form', { name: 'Novo usuário' });
    await user.type(within(form).getByLabelText('E-mail'), 'novo@clinica.com');
    await user.type(within(form).getByLabelText('Senha inicial'), 'senha-forte-1');
    await user.click(within(form).getByRole('button', { name: 'Criar usuário' }));

    expect(within(form).getByRole('alert')).toHaveTextContent(/a qual terapeuta este acesso pertence/i);
    expect(api.sent('POST', '/users')).toHaveLength(0);
  });

  it('desativar pede confirmação, explica o efeito e chama POST /users/:id/deactivate', async () => {
    signIn();
    const user = userEvent.setup();
    const api = mockUsers({ 'POST /users/:id/deactivate': { body: { ...THERAPIST_USER, isActive: false } } });
    renderWithQueryClient(<UsuariosPage />);

    await user.click(within((await screen.findByText('marta@clinica.com')).closest('li') as HTMLElement).getByRole('button', { name: 'Desativar' }));
    const dialog = screen.getByRole('dialog', { name: /desativar este usuário/i });
    expect(dialog).toHaveTextContent(/perde o acesso ao painel/i);
    expect(api.sent('POST', '/users/:id/deactivate')).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Desativar usuário' }));

    await waitFor(() => expect(api.sent('POST', '/users/:id/deactivate')).toHaveLength(1));
    expect(api.sent('POST', '/users/:id/deactivate')[0].path).toBe('/users/user-2/deactivate');
  });

  it('reativar devolve o acesso', async () => {
    signIn();
    const api = mockUsers({ 'POST /users/:id/reactivate': { body: { ...INACTIVE, isActive: true } } });
    renderWithQueryClient(<UsuariosPage />);

    await userEvent.setup().click(within((await screen.findByText('antigo@clinica.com')).closest('li') as HTMLElement).getByRole('button', { name: 'Reativar' }));

    await waitFor(() => expect(api.sent('POST', '/users/:id/reactivate')[0].path).toBe('/users/user-3/reactivate'));
    expect(await screen.findByRole('status')).toHaveTextContent(/voltou a ter acesso/i);
  });

  it('perfil terapeuta não vê a gestão de usuários nem consulta a lista', async () => {
    signIn('therapist');
    const api = mockUsers();
    renderWithQueryClient(<UsuariosPage />);

    expect(screen.getByText(/restrita a administradores/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Novo usuário' })).not.toBeInTheDocument();
    expect(api.sent('GET', '/users')).toHaveLength(0);
  });
});

describe('WhatsAppConnection', () => {
  async function fill(user: ReturnType<typeof userEvent.setup>, phoneNumberId: string, token: string) {
    await user.type(screen.getByLabelText(/identificador do número/i), phoneNumberId);
    await user.type(screen.getByLabelText('Token de acesso'), token);
    await user.click(screen.getByRole('button', { name: 'Conectar WhatsApp' }));
  }

  it('grava a conexão pela API e apaga o token da tela em seguida', async () => {
    signIn();
    const user = userEvent.setup();
    const api = mockApi({ 'POST /whatsapp/connect': { status: 201, body: { status: 'connected' } } });
    renderWithQueryClient(<WhatsAppConnection />);

    await fill(user, '123456789012345', 'token-de-teste-nao-real');

    await waitFor(() => expect(api.sent('POST', '/whatsapp/connect')).toHaveLength(1));
    expect(api.sent('POST', '/whatsapp/connect')[0].body).toEqual({ phoneNumberId: '123456789012345', accessToken: 'token-de-teste-nao-real' });
    expect(await screen.findByRole('status')).toHaveTextContent(/canal gravado/i);
    expect(screen.getByLabelText('Token de acesso')).toHaveValue('');
  });

  it('o campo do token é do tipo senha e não é guardado no navegador', async () => {
    signIn();
    const user = userEvent.setup();
    mockApi({ 'POST /whatsapp/connect': { status: 201, body: { status: 'connected' } } });
    renderWithQueryClient(<WhatsAppConnection />);

    expect(screen.getByLabelText('Token de acesso')).toHaveAttribute('type', 'password');
    await fill(user, '123456789012345', 'token-secreto-que-nao-pode-vazar');

    await screen.findByRole('status');
    expect(JSON.stringify({ ...localStorage })).not.toContain('token-secreto-que-nao-pode-vazar');
    expect(document.body.innerHTML).not.toContain('token-secreto-que-nao-pode-vazar');
  });

  it('telefone no lugar do identificador: explica a diferença, sem chamar a API', async () => {
    signIn();
    const user = userEvent.setup();
    const api = mockApi({});
    renderWithQueryClient(<WhatsAppConnection />);

    await fill(user, '+55 41 99999-0000', 'token-qualquer');

    expect(screen.getByRole('alert')).toHaveTextContent(/não o telefone/i);
    expect(api.sent('POST', '/whatsapp/connect')).toHaveLength(0);
  });

  it('erro da API: mensagem clara, e o token também é apagado da tela', async () => {
    signIn();
    const user = userEvent.setup();
    mockApi({ 'POST /whatsapp/connect': apiError(403, 'FORBIDDEN', 'Ação restrita a: admin.') });
    renderWithQueryClient(<WhatsAppConnection />);

    await fill(user, '123456789012345', 'token-qualquer');

    expect(await screen.findByRole('alert')).toHaveTextContent(/perfil não tem permissão/i);
    expect(screen.getByLabelText('Token de acesso')).toHaveValue('');
  });

  it('avisa que a tela não confere o token com a Meta nem mostra o estado da conexão', () => {
    signIn();
    mockApi({});
    renderWithQueryClient(<WhatsAppConnection />);

    expect(screen.getByText(/não confere o token com a Meta/i)).toBeInTheDocument();
  });
});

describe('OnboardingChecklist', () => {
  function mockSetup(options: { pix?: boolean; therapists?: boolean; windows?: boolean; users?: number; patients?: boolean }) {
    return mockApi({
      'GET /clinic': {
        body: { name: 'Clínica', defaultBillingPolicy: 'per_session', cancellationHoursLimit: null, defaultSessionDurationMinutes: 50, pixKey: options.pix ? 'chave' : null, payeeName: options.pix ? 'Clínica' : null },
      },
      'GET /therapists': { body: { data: options.therapists ? [{ id: 't1', name: 'Dra. Marta', specialty: null }] : [] } },
      'GET /therapists/:id/availability/calendar': options.windows
        ? { body: { therapistId: 't1', windows: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00', sessionDurationMinutes: 50 }], exceptions: [] } }
        : apiError(404, 'NOT_FOUND', 'Calendário não encontrado.'),
      'GET /users': { body: { data: Array.from({ length: options.users ?? 1 }, (_, index) => ({ ...ME, id: `u${index}` })) } },
      'GET /patients': { body: { data: options.patients ? [{ id: 'p1', name: 'Ana', phone: '1', state: 'Ativo', billingPolicyOverride: null }] : [] } },
    });
  }

  it('clínica recém-criada: mostra o que falta, cada item com o link da tela', async () => {
    signIn();
    mockSetup({});
    renderWithQueryClient(<OnboardingChecklist />);

    const list = await screen.findByRole('region', { name: 'Primeiros passos' });
    expect(list).toHaveTextContent(/0 de 5 prontos/);
    expect(within(list).getByRole('link', { name: 'Horários de atendimento' })).toHaveAttribute('href', '/disponibilidade');
    expect(within(list).getByRole('link', { name: 'Acesso da equipe' })).toHaveAttribute('href', '/usuarios');
    expect(within(list).getByRole('link', { name: 'WhatsApp da clínica' }).closest('li')).toHaveTextContent(/confira/);
  });

  it('marca como pronto o que a API mostra que já foi feito', async () => {
    signIn();
    mockSetup({ pix: true, therapists: true, windows: true });
    renderWithQueryClient(<OnboardingChecklist />);

    const list = await screen.findByRole('region', { name: 'Primeiros passos' });
    expect(list).toHaveTextContent(/3 de 5 prontos/);
    expect(within(list).getByRole('link', { name: 'Horários de atendimento' }).closest('li')).toHaveTextContent(/pronto/);
    expect(within(list).getByRole('link', { name: 'Pacientes' }).closest('li')).toHaveTextContent(/falta fazer/);
  });

  it('com tudo o que dá para conferir pronto, a lista some', async () => {
    signIn();
    const api = mockSetup({ pix: true, therapists: true, windows: true, users: 2, patients: true });
    renderWithQueryClient(<OnboardingChecklist />);

    await waitFor(() => expect(api.sent('GET', '/therapists/:id/availability/calendar')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Primeiros passos' })).not.toBeInTheDocument());
  });

  it('se algum dado não carrega, não mostra nada — a ajuda não vira mais um erro na tela', async () => {
    signIn();
    const api = mockApi({ 'GET /clinic': apiError(500, 'INTERNAL_SERVER_ERROR', 'erro') });
    renderWithQueryClient(<OnboardingChecklist />);

    await waitFor(() => expect(api.sent('GET', '/clinic').length).toBeGreaterThan(0));
    expect(screen.queryByRole('region', { name: 'Primeiros passos' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
