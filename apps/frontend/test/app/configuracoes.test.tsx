import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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

/**
 * Tarefa 07 da auditoria — AD-039 (ADR-0064): o fuso da clínica em
 * Configurações. Todos o veem; só o administrador o altera, depois de
 * confirmar que entendeu o efeito.
 */
describe('ConfiguracoesPage — fuso horário da clínica', () => {
  type Routes = Record<string, MockReply | ((request: MockRequest) => MockReply)>;

  const CLINIC = {
    name: 'Clínica Teste',
    defaultBillingPolicy: 'weekly',
    cancellationHoursLimit: 24,
    defaultSessionDurationMinutes: 50,
    pixKey: 'chave-pix-teste',
    payeeName: 'Clínica Teste Ltda',
    timeZone: 'America/Sao_Paulo',
  };

  /** A API simulada guarda o fuso: o que o PUT grava é o que o GET seguinte devolve. */
  function mockClinicApi(overrides: Routes = {}, clinic: Record<string, unknown> = CLINIC) {
    let current = clinic;
    return mockApi({
      'GET /clinic': () => ({ body: current }),
      'PUT /clinic/time-zone': (request) => {
        current = { ...current, timeZone: (request.body as { timeZone: string }).timeZone };
        return { body: current };
      },
      'GET /notifications/unread-count': { body: { count: 0 } },
      ...overrides,
    });
  }

  function signIn(role: 'admin' | 'therapist' = 'admin') {
    useAuthStore.setState({ accessToken: fakeToken(role), refreshToken: 'fake-refresh' });
  }

  const section = () => screen.findByRole('region', { name: 'Fuso horário' });

  beforeEach(() => signIn());

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ accessToken: null, refreshToken: null });
  });

  it('mostra o fuso em vigor e explica para que ele serve', async () => {
    mockClinicApi();
    renderWithQueryClient(<ConfiguracoesPage />);

    const region = await section();
    expect(region).toHaveTextContent('Fuso atual: Brasília (São Paulo) — America/Sao_Paulo');
    expect(region).toHaveTextContent(/agora na clínica/i);
    expect(region).toHaveTextContent(/horários de atendimento, a agenda e o dia de vencimento das cobranças valem nele/i);
  });

  it('terapeuta vê o fuso, mas não tem como alterá-lo', async () => {
    signIn('therapist');
    const api = mockClinicApi();
    renderWithQueryClient(<ConfiguracoesPage />);

    const region = await section();
    expect(region).toHaveTextContent('Fuso atual: Brasília (São Paulo) — America/Sao_Paulo');
    expect(region).toHaveTextContent('Só um administrador pode alterar o fuso da clínica.');
    expect(within(region).queryByRole('form')).not.toBeInTheDocument();
    expect(within(region).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(region).queryByRole('button')).not.toBeInTheDocument();
    expect(api.sent('PUT', '/clinic/time-zone')).toHaveLength(0);
  });

  it('administrador: a lista traz os fusos do Brasil e os demais, e parte do fuso em vigor', async () => {
    mockClinicApi();
    renderWithQueryClient(<ConfiguracoesPage />);

    const select = within(await section()).getByLabelText('Novo fuso');
    expect(select).toHaveValue('America/Sao_Paulo');
    expect(within(select).getByRole('option', { name: 'Manaus — America/Manaus' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Fernando de Noronha — America/Noronha' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Europe/Lisbon' })).toBeInTheDocument();
    expect(within(select).getAllByRole('option', { name: /America\/Sao_Paulo/ })).toHaveLength(1);
  });

  it('o botão só habilita quando o fuso escolhido é diferente do atual', async () => {
    const user = userEvent.setup();
    mockClinicApi();
    renderWithQueryClient(<ConfiguracoesPage />);
    const region = await section();
    const button = within(region).getByRole('button', { name: 'Alterar fuso' });

    expect(button).toBeDisabled();
    await user.selectOptions(within(region).getByLabelText('Novo fuso'), 'America/Manaus');
    expect(button).toBeEnabled();
    await user.selectOptions(within(region).getByLabelText('Novo fuso'), 'America/Sao_Paulo');
    expect(button).toBeDisabled();
  });

  it('alterar pede confirmação e diz o que muda e o que não é reescrito; "Voltar" não chama a API', async () => {
    const user = userEvent.setup();
    const api = mockClinicApi();
    renderWithQueryClient(<ConfiguracoesPage />);
    const region = await section();

    await user.selectOptions(within(region).getByLabelText('Novo fuso'), 'America/Manaus');
    await user.click(within(region).getByRole('button', { name: 'Alterar fuso' }));

    const dialog = screen.getByRole('dialog', { name: 'Alterar o fuso da clínica?' });
    expect(dialog).toHaveTextContent('De America/Sao_Paulo para America/Manaus');
    expect(dialog).toHaveTextContent(/vale daqui em diante/i);
    expect(dialog).toHaveTextContent(/horários de atendimento .* e o dia de vencimento das cobranças passam a valer no novo fuso/i);
    expect(dialog).toHaveTextContent(/nada do que já foi gravado é reescrito/i);
    expect(dialog).toHaveTextContent(/continuam no mesmo instante/i);
    expect(dialog).toHaveTextContent(/valores, pagamentos e datas de vencimento não mudam/i);
    expect(api.sent('PUT', '/clinic/time-zone')).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Voltar' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.sent('PUT', '/clinic/time-zone')).toHaveLength(0);
    expect(region).toHaveTextContent('Fuso atual: Brasília (São Paulo) — America/Sao_Paulo');
  });

  it('confirmar envia o fuso escolhido, avisa que deu certo e passa a mostrar o fuso novo, relido da API', async () => {
    const user = userEvent.setup();
    const api = mockClinicApi();
    renderWithQueryClient(<ConfiguracoesPage />);
    const region = await section();

    await user.selectOptions(within(region).getByLabelText('Novo fuso'), 'America/Manaus');
    await user.click(within(region).getByRole('button', { name: 'Alterar fuso' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Alterar fuso' }));

    expect(await within(region).findByRole('status')).toHaveTextContent('Fuso da clínica alterado para Manaus — America/Manaus.');
    expect(api.sent('PUT', '/clinic/time-zone')).toHaveLength(1);
    expect(api.sent('PUT', '/clinic/time-zone')[0].body).toEqual({ timeZone: 'America/Manaus' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(region).toHaveTextContent('Fuso atual: Manaus — America/Manaus'));
    expect(api.sent('GET', '/clinic').length).toBeGreaterThan(1);
    // Com o fuso novo em vigor, não há o que alterar até escolher outro.
    expect(within(region).getByRole('button', { name: 'Alterar fuso' })).toBeDisabled();
    // As outras rotas de edição não foram chamadas de carona.
    expect(api.sent('PUT', '/clinic/policies')).toHaveLength(0);
    expect(api.sent('PUT', '/clinic/payment-info')).toHaveLength(0);
  });

  it('recusa da API: o motivo aparece na confirmação, que continua aberta, e a tela não diz que alterou', async () => {
    const user = userEvent.setup();
    mockClinicApi({ 'PUT /clinic/time-zone': apiError(403, 'FORBIDDEN', 'Forbidden resource') });
    renderWithQueryClient(<ConfiguracoesPage />);
    const region = await section();

    await user.selectOptions(within(region).getByLabelText('Novo fuso'), 'America/Manaus');
    await user.click(within(region).getByRole('button', { name: 'Alterar fuso' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Alterar fuso' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Seu perfil não tem permissão para esta ação.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(region).queryByRole('status')).not.toBeInTheDocument();
    expect(region).toHaveTextContent('Fuso atual: Brasília (São Paulo) — America/Sao_Paulo');
  });

  it('fuso gravado que este navegador não conhece: aparece pelo nome, sem quebrar a tela', async () => {
    mockClinicApi({}, { ...CLINIC, timeZone: 'Zona/Desconhecida' });
    renderWithQueryClient(<ConfiguracoesPage />);

    const region = await section();
    expect(region).toHaveTextContent('Fuso atual: Zona/Desconhecida');
    expect(region).not.toHaveTextContent(/agora na clínica/i);
    expect(within(region).getByLabelText('Novo fuso')).toHaveValue('Zona/Desconhecida');
    // Os formulários que já existiam continuam na tela.
    expect(screen.getByDisplayValue('chave-pix-teste')).toBeInTheDocument();
  });
});
