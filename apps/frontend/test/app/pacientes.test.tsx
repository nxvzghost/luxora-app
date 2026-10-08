import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithQueryClient, mockFailingFetch } from '../support/render-with-query';
import { apiError, fakeToken, mockApi } from '../support/mock-api';
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

/**
 * Tarefa 06 da auditoria (AD-031) — a tela só tinha os dois testes de erro
 * de carregamento acima. Faltava o que a equipe faz nela: ver a lista e
 * cadastrar um paciente.
 */
describe('PacientesPage — lista e cadastro', () => {
  const ANA = { id: 'patient-1', name: 'Ana Teste', phone: '+5541900000001', state: 'Ativo', billingPolicyOverride: null };
  const BRUNO = { id: 'patient-2', name: 'Bruno Teste', phone: '+5541900000002', state: 'Inativo', billingPolicyOverride: null };

  beforeEach(() => {
    useAuthStore.setState({ accessToken: fakeToken('admin'), refreshToken: 'fake-refresh' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ accessToken: null, refreshToken: null });
  });

  it('sem pacientes: diz que não há nenhum, sem parecer erro', async () => {
    mockApi({ 'GET /patients': { body: { data: [] } } });
    renderWithQueryClient(<PacientesPage />);

    expect(await screen.findByText('Nenhum paciente cadastrado ainda.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('lista cada paciente com o telefone e o estado', async () => {
    mockApi({ 'GET /patients': { body: { data: [ANA, BRUNO] } } });
    renderWithQueryClient(<PacientesPage />);

    const ana = (await screen.findByText('Ana Teste')).closest('li');
    expect(ana).toHaveTextContent('+5541900000001');
    expect(ana).toHaveTextContent('Ativo');
    expect(screen.getByText('Bruno Teste').closest('li')).toHaveTextContent('Inativo');
    expect(screen.queryByText('Nenhum paciente cadastrado ainda.')).not.toBeInTheDocument();
  });

  it('cadastrar envia nome e telefone, fecha o formulário e mostra o paciente novo', async () => {
    const user = userEvent.setup();
    const patients = [ANA];
    const api = mockApi({
      'GET /patients': () => ({ body: { data: [...patients] } }),
      'POST /patients': (request) => {
        const created = { ...BRUNO, ...(request.body as { name: string; phone: string }), state: 'Cadastrado' };
        patients.push(created);
        return { status: 201, body: created };
      },
    });
    renderWithQueryClient(<PacientesPage />);
    await screen.findByText('Ana Teste');

    await user.click(screen.getByRole('button', { name: 'Novo paciente' }));
    await user.type(screen.getByPlaceholderText('Nome'), 'Bruno Teste');
    await user.type(screen.getByPlaceholderText('Telefone (WhatsApp)'), '(41) 90000-0002');
    await user.click(screen.getByRole('button', { name: 'Cadastrar' }));

    expect(await screen.findByText('Bruno Teste')).toBeInTheDocument();
    expect(api.sent('POST', '/patients')).toHaveLength(1);
    expect(api.sent('POST', '/patients')[0].body).toEqual({ name: 'Bruno Teste', phone: '(41) 90000-0002' });
    expect(screen.queryByPlaceholderText('Nome')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Novo paciente' })).toBeInTheDocument();
  });

  it('recusa da API: mostra o motivo, mantém o que foi digitado e não lista paciente que não existe', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /patients': { body: { data: [ANA] } },
      'POST /patients': apiError(409, 'CONFLICT', 'Nome do paciente é obrigatório.'),
    });
    renderWithQueryClient(<PacientesPage />);
    await screen.findByText('Ana Teste');

    await user.click(screen.getByRole('button', { name: 'Novo paciente' }));
    await user.type(screen.getByPlaceholderText('Nome'), 'Carla Teste');
    await user.type(screen.getByPlaceholderText('Telefone (WhatsApp)'), '41900000003');
    await user.click(screen.getByRole('button', { name: 'Cadastrar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Nome do paciente é obrigatório.');
    expect(screen.getByPlaceholderText('Nome')).toHaveValue('Carla Teste');
    expect(screen.getByPlaceholderText('Telefone (WhatsApp)')).toHaveValue('41900000003');
    expect(screen.queryByText('Carla Teste')).not.toBeInTheDocument();
  });

  it('enquanto salva, o botão fica travado — um segundo clique não cadastra duas vezes', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /patients': { body: { data: [] } },
      'POST /patients': { status: 201, body: BRUNO },
    });
    // Segura só a resposta do cadastro, para o teste alcançar a tela no meio do envio.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const answer = api.fetchMock.getMockImplementation()!;
    api.fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'POST') await held;
      return answer(input, init);
    });
    renderWithQueryClient(<PacientesPage />);

    await user.click(screen.getByRole('button', { name: 'Novo paciente' }));
    await user.type(screen.getByPlaceholderText('Nome'), 'Bruno Teste');
    await user.type(screen.getByPlaceholderText('Telefone (WhatsApp)'), '41900000002');
    await user.click(screen.getByRole('button', { name: 'Cadastrar' }));

    const saving = await screen.findByRole('button', { name: 'Salvando...' });
    expect(saving).toBeDisabled();
    await user.click(saving);
    release();

    await waitFor(() => expect(screen.queryByPlaceholderText('Nome')).not.toBeInTheDocument());
    expect(api.sent('POST', '/patients')).toHaveLength(1);
  });
});
