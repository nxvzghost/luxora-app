import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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
  // O administrador também vê os números aguardando vínculo (ADR-0063); aqui, nenhum.
  const NO_PENDING = { 'GET /contacts/pending': { body: { data: [] } } };

  beforeEach(() => {
    useAuthStore.setState({ accessToken: fakeToken('admin'), refreshToken: 'fake-refresh' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ accessToken: null, refreshToken: null });
  });

  it('sem pacientes: diz que não há nenhum, sem parecer erro', async () => {
    mockApi({ 'GET /patients': { body: { data: [] } }, ...NO_PENDING });
    renderWithQueryClient(<PacientesPage />);

    expect(await screen.findByText('Nenhum paciente cadastrado ainda.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('lista cada paciente com o telefone e o estado', async () => {
    mockApi({ 'GET /patients': { body: { data: [ANA, BRUNO] } }, ...NO_PENDING });
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
      ...NO_PENDING,
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
      ...NO_PENDING,
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
      ...NO_PENDING,
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

/**
 * ADR-0063 (AD-038) — a aprovação, pelo painel, do vínculo de um número novo
 * de WhatsApp a um paciente que já existe. Só o administrador vê e aprova.
 */
describe('PacientesPage — números aguardando vínculo (ADR-0063, AD-038)', () => {
  const ANA = { id: 'patient-1', name: 'Ana Teste', phone: '+5541900000001', state: 'Ativo', billingPolicyOverride: null };
  const BRUNO = { id: 'patient-2', name: 'Bruno Teste', phone: '+5541900000002', state: 'Ativo', billingPolicyOverride: null };
  const NAMED = { id: 'contact-1', phoneNumber: '+5541988887777', name: 'Ana Teste', state: 'Identificado', createdAt: '2026-10-09T12:00:00.000Z' };
  const UNNAMED = { id: 'contact-2', phoneNumber: '+5541988886666', name: null, state: 'Conversando', createdAt: '2026-10-09T13:00:00.000Z' };
  const PATIENTS = { 'GET /patients': { body: { data: [ANA, BRUNO] } } };

  const section = () => screen.getByRole('region', { name: 'Números aguardando vínculo' });

  beforeEach(() => {
    useAuthStore.setState({ accessToken: fakeToken('admin'), refreshToken: 'fake-refresh' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ accessToken: null, refreshToken: null });
  });

  it('terapeuta: a seção não aparece e a lista de pendentes nem é pedida', async () => {
    useAuthStore.setState({ accessToken: fakeToken('therapist'), refreshToken: 'fake-refresh' });
    const api = mockApi({ ...PATIENTS, 'GET /contacts/pending': { body: { data: [NAMED] } } });
    renderWithQueryClient(<PacientesPage />);
    await screen.findByText('Ana Teste');

    expect(screen.queryByRole('region', { name: 'Números aguardando vínculo' })).not.toBeInTheDocument();
    expect(screen.queryByText('+5541988887777')).not.toBeInTheDocument();
    expect(api.sent('GET', '/contacts/pending')).toHaveLength(0);
  });

  it('nenhum número pendente: a seção diz isso, sem parecer erro', async () => {
    mockApi({ ...PATIENTS, 'GET /contacts/pending': { body: { data: [] } } });
    renderWithQueryClient(<PacientesPage />);

    expect(await within(section()).findByText('Nenhum número aguardando vínculo.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('falha ao carregar os pendentes: mostra o erro e não diz que não há nenhum', async () => {
    mockApi({ ...PATIENTS, 'GET /contacts/pending': apiError(500, 'INTERNAL', 'erro simulado') });
    renderWithQueryClient(<PacientesPage />);

    expect(await within(section()).findByRole('alert')).toHaveTextContent(/não foi possível carregar os números aguardando vínculo/i);
    expect(screen.queryByText('Nenhum número aguardando vínculo.')).not.toBeInTheDocument();
    // A lista de pacientes continua de pé.
    expect(screen.getByText('Bruno Teste')).toBeInTheDocument();
  });

  it('lista o número e o nome informado como não conferido; sem paciente escolhido, não dá para vincular', async () => {
    mockApi({ ...PATIENTS, 'GET /contacts/pending': { body: { data: [NAMED, UNNAMED] } } });
    renderWithQueryClient(<PacientesPage />);

    const named = (await within(section()).findByText('+5541988887777')).closest('li')!;
    const unnamed = within(section()).getByText('+5541988886666').closest('li')!;

    expect(named).toHaveTextContent('Nome informado na conversa: Ana Teste');
    expect(unnamed).toHaveTextContent('Não informou nome');
    expect(section()).toHaveTextContent(/ninguém o conferiu/i);
    expect(within(named).getByRole('button', { name: 'Vincular' })).toBeDisabled();
    expect(within(unnamed).getByRole('button', { name: 'Vincular' })).toBeDisabled();
  });

  it('escolher o paciente e clicar em Vincular ainda não vincula: pede a confirmação, dizendo o que muda', async () => {
    const user = userEvent.setup();
    const api = mockApi({ ...PATIENTS, 'GET /contacts/pending': { body: { data: [NAMED] } } });
    renderWithQueryClient(<PacientesPage />);
    await within(section()).findByText('+5541988887777');
    await screen.findByText('Bruno Teste');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Paciente para o número +5541988887777' }), 'patient-1');
    await user.click(within(section()).getByRole('button', { name: 'Vincular' }));

    const dialog = screen.getByRole('dialog', { name: 'Aprovar o vínculo deste número?' });
    expect(dialog).toHaveTextContent('+5541988887777');
    expect(dialog).toHaveTextContent('Ana Teste');
    expect(dialog).toHaveTextContent(/por outro meio/i);
    expect(dialog).toHaveTextContent(/fica registrada no seu usuário/i);
    expect(api.sent('POST', '/contacts/:id/link')).toHaveLength(0);

    // Voltar desiste sem enviar nada.
    await user.click(within(dialog).getByRole('button', { name: 'Voltar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.sent('POST', '/contacts/:id/link')).toHaveLength(0);
  });

  it('aprovar envia o contato e o paciente escolhido, confirma na tela e tira o número da lista', async () => {
    const user = userEvent.setup();
    const pending = [NAMED, UNNAMED];
    const api = mockApi({
      ...PATIENTS,
      'GET /contacts/pending': () => ({ body: { data: [...pending] } }),
      'POST /contacts/:id/link': (request) => {
        pending.splice(0, 1);
        return {
          status: 201,
          body: {
            contactId: 'contact-1',
            patientId: (request.body as { patientId: string }).patientId,
            state: 'Vinculado',
            approvedByUserId: 'user-1',
            approvedAt: '2026-10-09T14:00:00.000Z',
          },
        };
      },
    });
    renderWithQueryClient(<PacientesPage />);
    await within(section()).findByText('+5541988887777');
    await screen.findByText('Bruno Teste');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Paciente para o número +5541988887777' }), 'patient-2');
    await user.click(within(screen.getByText('+5541988887777').closest('li')!).getByRole('button', { name: 'Vincular' }));
    await user.click(screen.getByRole('button', { name: 'Aprovar vínculo' }));

    expect(await screen.findByRole('status')).toHaveTextContent('O número +5541988887777 agora identifica Bruno Teste no WhatsApp.');
    const sent = api.sent('POST', '/contacts/:id/link');
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toBe('/contacts/contact-1/link');
    expect(sent[0].body).toEqual({ patientId: 'patient-2' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(within(section()).queryByText('+5541988887777')).not.toBeInTheDocument());
    expect(within(section()).getByText('+5541988886666')).toBeInTheDocument();
  });

  it('recusa da API: o motivo aparece na própria confirmação, nada é dado como vinculado e o número continua na lista', async () => {
    const user = userEvent.setup();
    mockApi({
      ...PATIENTS,
      'GET /contacts/pending': { body: { data: [NAMED] } },
      'POST /contacts/:id/link': apiError(409, 'CONFLICT', 'Este contato já está vinculado a um paciente.'),
    });
    renderWithQueryClient(<PacientesPage />);
    await within(section()).findByText('+5541988887777');
    await screen.findByText('Bruno Teste');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Paciente para o número +5541988887777' }), 'patient-1');
    await user.click(within(section()).getByRole('button', { name: 'Vincular' }));
    await user.click(screen.getByRole('button', { name: 'Aprovar vínculo' }));

    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Este contato já está vinculado a um paciente.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    // O número continua na lista, com a escolha do paciente ainda disponível.
    expect(screen.getByRole('combobox', { name: 'Paciente para o número +5541988887777' })).toBeInTheDocument();
  });

  it('sem permissão na API (403): diz que o perfil não pode, e nada é dado como vinculado', async () => {
    const user = userEvent.setup();
    mockApi({
      ...PATIENTS,
      'GET /contacts/pending': { body: { data: [NAMED] } },
      'POST /contacts/:id/link': apiError(403, 'FORBIDDEN', 'Forbidden resource'),
    });
    renderWithQueryClient(<PacientesPage />);
    await within(section()).findByText('+5541988887777');
    await screen.findByText('Bruno Teste');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Paciente para o número +5541988887777' }), 'patient-1');
    await user.click(within(section()).getByRole('button', { name: 'Vincular' }));
    await user.click(screen.getByRole('button', { name: 'Aprovar vínculo' }));

    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('Seu perfil não tem permissão para esta ação.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('enquanto aprova, o botão fica travado — um segundo clique não aprova duas vezes', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...PATIENTS,
      'GET /contacts/pending': { body: { data: [NAMED] } },
      'POST /contacts/:id/link': {
        status: 201,
        body: { contactId: 'contact-1', patientId: 'patient-1', state: 'Vinculado', approvedByUserId: 'user-1', approvedAt: '2026-10-09T14:00:00.000Z' },
      },
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const answer = api.fetchMock.getMockImplementation()!;
    api.fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'POST') await held;
      return answer(input, init);
    });
    renderWithQueryClient(<PacientesPage />);
    await within(section()).findByText('+5541988887777');
    await screen.findByText('Bruno Teste');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Paciente para o número +5541988887777' }), 'patient-1');
    await user.click(within(section()).getByRole('button', { name: 'Vincular' }));
    await user.click(screen.getByRole('button', { name: 'Aprovar vínculo' }));

    const approving = await screen.findByRole('button', { name: 'Aprovando...' });
    expect(approving).toBeDisabled();
    await user.click(approving);
    release();

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.sent('POST', '/contacts/:id/link')).toHaveLength(1);
  });
});
