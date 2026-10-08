import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithQueryClient, mockFailingFetch } from '../support/render-with-query';
import { apiError, fakeToken, mockApi, type MockReply, type MockRequest } from '../support/mock-api';
import { useAuthStore } from '@/lib/stores/auth.store';
import ConfiguracoesPage from '@/app/configuracoes/page';

describe('ConfiguracoesPage — Fase 9.2 (AD-014) — isError', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'fake-token', refreshToken: 'fake-refresh' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ accessToken: null, refreshToken: null });
  });

  it('exibe mensagem de erro visível quando a busca da clínica falha', async () => {
    vi.stubGlobal('fetch', mockFailingFetch());
    renderWithQueryClient(<ConfiguracoesPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/não foi possível carregar as configurações/i);
    });
  });

  it('não renderiza o formulário de políticas quando há erro (evita editar sobre dado desconhecido)', async () => {
    vi.stubGlobal('fetch', mockFailingFetch());
    renderWithQueryClient(<ConfiguracoesPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.queryByText(/políticas da clínica/i)).not.toBeInTheDocument();
  });
});

/**
 * Tarefa 06 da auditoria (AD-031) — a tela só tinha os dois testes de erro
 * de carregamento acima. Faltavam os dois formulários: o que é carregado, o
 * que é enviado e o que a pessoa vê quando o servidor recusa.
 */
describe('ConfiguracoesPage — formulários', () => {
  type Routes = Record<string, MockReply | ((request: MockRequest) => MockReply)>;

  const CLINIC = {
    name: 'Clínica Teste',
    defaultBillingPolicy: 'weekly',
    cancellationHoursLimit: 24,
    defaultSessionDurationMinutes: 50,
    pixKey: 'chave-pix-teste',
    payeeName: 'Clínica Teste Ltda',
  };

  function mockClinicApi(overrides: Routes = {}, clinic: Record<string, unknown> = CLINIC) {
    return mockApi({
      'GET /clinic': { body: clinic },
      'GET /notifications/unread-count': { body: { count: 0 } },
      ...overrides,
    });
  }

  function signIn(role: 'admin' | 'therapist' = 'admin') {
    useAuthStore.setState({ accessToken: fakeToken(role), refreshToken: 'fake-refresh' });
  }

  /** Os dois campos numéricos, na ordem da tela: limite de cancelamento e duração da sessão. */
  const numberFields = () => screen.getAllByRole('spinbutton');

  beforeEach(() => signIn());

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ accessToken: null, refreshToken: null });
  });

  it('carrega nos formulários o que a clínica já tem gravado', async () => {
    mockClinicApi();
    renderWithQueryClient(<ConfiguracoesPage />);

    expect(await screen.findByDisplayValue('chave-pix-teste')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Clínica Teste Ltda')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('weekly');
    expect(numberFields()[0]).toHaveValue(24);
    expect(numberFields()[1]).toHaveValue(50);
  });

  it('salvar políticas envia os valores como número e confirma na tela', async () => {
    const user = userEvent.setup();
    const api = mockClinicApi({ 'PUT /clinic/policies': { body: CLINIC } });
    renderWithQueryClient(<ConfiguracoesPage />);
    await screen.findByDisplayValue('chave-pix-teste');

    await user.selectOptions(screen.getByRole('combobox'), 'monthly');
    await user.clear(numberFields()[0]);
    await user.type(numberFields()[0], '48');
    await user.clear(numberFields()[1]);
    await user.type(numberFields()[1], '60');
    await user.click(screen.getByRole('button', { name: 'Salvar políticas' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Políticas salvas.');
    expect(api.sent('PUT', '/clinic/policies')[0].body).toEqual({
      defaultBillingPolicy: 'monthly',
      cancellationHoursLimit: 48,
      defaultSessionDurationMinutes: 60,
    });
  });

  it('limite de cancelamento em branco não é enviado como zero', async () => {
    const user = userEvent.setup();
    const api = mockClinicApi({ 'PUT /clinic/policies': { body: CLINIC } }, { ...CLINIC, cancellationHoursLimit: null });
    renderWithQueryClient(<ConfiguracoesPage />);
    await screen.findByDisplayValue('chave-pix-teste');
    expect(numberFields()[0]).toHaveValue(null);

    await user.click(screen.getByRole('button', { name: 'Salvar políticas' }));

    await screen.findByRole('status');
    expect(api.sent('PUT', '/clinic/policies')[0].body).toEqual({
      defaultBillingPolicy: 'weekly',
      defaultSessionDurationMinutes: 50,
    });
  });

  it('salvar os dados de recebimento envia a chave PIX e o beneficiário', async () => {
    const user = userEvent.setup();
    const api = mockClinicApi({ 'PUT /clinic/payment-info': { body: CLINIC } });
    renderWithQueryClient(<ConfiguracoesPage />);

    const pixKey = await screen.findByDisplayValue('chave-pix-teste');
    await user.clear(pixKey);
    await user.type(pixKey, 'nova-chave-teste');
    await user.click(screen.getByRole('button', { name: 'Salvar dados de pagamento' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Dados de pagamento salvos.');
    expect(api.sent('PUT', '/clinic/payment-info')[0].body).toEqual({ pixKey: 'nova-chave-teste', payeeName: 'Clínica Teste Ltda' });
    expect(api.sent('PUT', '/clinic/policies')).toHaveLength(0);
  });

  it('falha ao salvar: avisa que o servidor não concluiu e não diz que salvou', async () => {
    const user = userEvent.setup();
    mockClinicApi({ 'PUT /clinic/policies': apiError(500, 'INTERNAL', 'erro interno') });
    renderWithQueryClient(<ConfiguracoesPage />);
    await screen.findByDisplayValue('chave-pix-teste');

    await user.click(screen.getByRole('button', { name: 'Salvar políticas' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/não foi possível salvar.*o servidor não concluiu a ação/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('erro interno')).not.toBeInTheDocument();
  });

  it('admin vê a conexão do WhatsApp; terapeuta não', async () => {
    mockClinicApi();
    const admin = renderWithQueryClient(<ConfiguracoesPage />);
    expect(await screen.findByRole('heading', { name: 'WhatsApp da clínica' })).toBeInTheDocument();
    admin.unmount();

    signIn('therapist');
    renderWithQueryClient(<ConfiguracoesPage />);
    await screen.findByDisplayValue('chave-pix-teste');
    expect(screen.queryByRole('heading', { name: 'WhatsApp da clínica' })).not.toBeInTheDocument();
  });

  it('terapeuta: a recusa da API ao salvar vira uma frase clara sobre permissão', async () => {
    const user = userEvent.setup();
    signIn('therapist');
    mockClinicApi({ 'PUT /clinic/payment-info': apiError(403, 'FORBIDDEN', 'Forbidden resource') });
    renderWithQueryClient(<ConfiguracoesPage />);
    await screen.findByDisplayValue('chave-pix-teste');

    await user.click(screen.getByRole('button', { name: 'Salvar dados de pagamento' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Seu perfil não tem permissão para esta ação.');
    expect(screen.queryByText('Forbidden resource')).not.toBeInTheDocument();
  });
});
