import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithQueryClient, mockFailingFetch } from '../support/render-with-query';
import { apiError, fakeToken, mockApi, type MockReply, type MockRequest } from '../support/mock-api';
import { useAuthStore } from '@/lib/stores/auth.store';
import SubscriptionPage from '@/app/settings/subscription/page';

/**
 * SubscriptionPage — Tarefa 06 da auditoria (AD-031). A tela não tinha
 * nenhum teste: o estado da assinatura, a escolha do plano e do ciclo, e as
 * duas chamadas do checkout (criar a assinatura, registrar o cartão).
 *
 * A API é simulada no navegador; nenhuma chamada chega ao backend nem à
 * Asaas. O número de cartão usado é só zeros.
 */

type Routes = Record<string, MockReply | ((request: MockRequest) => MockReply)>;

const NO_SUBSCRIPTION = apiError(404, 'NOT_FOUND', 'Assinatura não encontrada.');
const CREATED = { body: { plan: 'professional', billingCycle: 'monthly', status: 'Trialing', amountPerCycle: 597, pendingPlan: null } };

function mockSubscriptionApi(overrides: Routes = {}) {
  return mockApi({
    'GET /subscription': NO_SUBSCRIPTION,
    'GET /notifications/unread-count': { body: { count: 0 } },
    ...overrides,
  });
}

async function fillClinic(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByPlaceholderText('Nome da clínica'), 'Clínica Teste');
  await user.type(screen.getByPlaceholderText('E-mail'), 'financeiro@clinica-teste.dev');
  await user.type(screen.getByPlaceholderText('CPF ou CNPJ'), '00000000000');
}

async function fillCard(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('Nome no cartão'), 'TITULAR TESTE');
  await user.type(screen.getByPlaceholderText('Número do cartão'), '0000000000000000');
  await user.type(screen.getByPlaceholderText('MM'), '12');
  await user.type(screen.getByPlaceholderText('AAAA'), '2099');
  await user.type(screen.getByPlaceholderText('CVV'), '000');
}

beforeEach(() => {
  useAuthStore.setState({ accessToken: fakeToken('admin'), refreshToken: 'fake-refresh' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ accessToken: null, refreshToken: null });
});

describe('SubscriptionPage — estado da assinatura', () => {
  it('clínica com assinatura: mostra o plano e a situação, sem o checkout', async () => {
    mockSubscriptionApi({ 'GET /subscription': { body: { plan: 'business', billingCycle: 'yearly', status: 'Active', amountPerCycle: 10767.6 } } });
    renderWithQueryClient(<SubscriptionPage />);

    expect(await screen.findByRole('heading', { name: 'Sua assinatura' })).toBeInTheDocument();
    expect(screen.getByText('business')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assinar agora' })).not.toBeInTheDocument();
  });

  it('clínica sem assinatura (404): mostra os planos com os preços mensais', async () => {
    mockSubscriptionApi();
    renderWithQueryClient(<SubscriptionPage />);

    expect(await screen.findByRole('heading', { name: 'Escolha seu plano' })).toBeInTheDocument();
    expect(screen.getByText('R$ 597,00/mês')).toBeInTheDocument();
    expect(screen.getByText('R$ 997,00/mês')).toBeInTheDocument();
    expect(screen.getByText('R$ 2.490,00/mês')).toBeInTheDocument();
  });

  it('enquanto a assinatura carrega, o checkout não aparece', async () => {
    let release: (value: unknown) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((resolve) => (release = resolve))),
    );
    renderWithQueryClient(<SubscriptionPage />);

    expect(await screen.findByText('Carregando...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assinar agora' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Número do cartão')).not.toBeInTheDocument();

    release({ ok: false, status: 404, json: async () => NO_SUBSCRIPTION.body });
    expect(await screen.findByRole('button', { name: 'Assinar agora' })).toBeInTheDocument();
  });

  it('falha ao carregar: avisa, e não oferece o checkout a quem pode já ser assinante', async () => {
    vi.stubGlobal('fetch', mockFailingFetch());
    renderWithQueryClient(<SubscriptionPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/não foi possível carregar a assinatura/i);
    expect(screen.queryByRole('button', { name: 'Assinar agora' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Número do cartão')).not.toBeInTheDocument();
  });
});

describe('SubscriptionPage — checkout', () => {
  it('ciclo anual: doze meses com 10% de desconto em cada plano', async () => {
    const user = userEvent.setup();
    mockSubscriptionApi();
    renderWithQueryClient(<SubscriptionPage />);

    await user.click(await screen.findByRole('button', { name: 'Anual (10% off)' }));

    expect(screen.getByText('R$ 6.447,60/ano')).toBeInTheDocument();
    expect(screen.getByText('R$ 10.767,60/ano')).toBeInTheDocument();
    expect(screen.getByText('R$ 26.892,00/ano')).toBeInTheDocument();
    expect(screen.getAllByText('10% de desconto aplicado')).toHaveLength(3);
  });

  it('cartão: cria a assinatura do plano e ciclo escolhidos e só então registra o cartão, no nome da clínica', async () => {
    const user = userEvent.setup();
    const api = mockSubscriptionApi({
      'POST /subscription': CREATED,
      'POST /subscription/credit-card': { body: { status: 'attached' } },
    });
    renderWithQueryClient(<SubscriptionPage />);
    await fillClinic(user);
    await user.click(screen.getByRole('button', { name: 'Anual (10% off)' }));
    await user.click(screen.getByRole('button', { name: /Business/ }));
    await fillCard(user);

    await user.click(screen.getByRole('button', { name: 'Assinar agora' }));

    expect(await screen.findByText(/Assinatura criada/)).toBeInTheDocument();
    expect(screen.getByText(/Seu cartão foi registrado/)).toBeInTheDocument();
    expect(api.sent('POST', '/subscription')[0].body).toEqual({
      plan: 'business',
      billingCycle: 'yearly',
      clinicName: 'Clínica Teste',
      clinicEmail: 'financeiro@clinica-teste.dev',
      clinicCpfCnpj: '00000000000',
      billingType: 'CREDIT_CARD',
    });
    expect(api.sent('POST', '/subscription/credit-card')[0].body).toEqual({
      holderName: 'TITULAR TESTE',
      number: '0000000000000000',
      expiryMonth: '12',
      expiryYear: '2099',
      ccv: '000',
      holderEmail: 'financeiro@clinica-teste.dev',
      holderCpfCnpj: '00000000000',
    });
    // A ordem importa: o cartão só é enviado depois de a assinatura existir.
    const posts = api.requests.filter((request) => request.method === 'POST').map((request) => request.path);
    expect(posts).toEqual(['/subscription', '/subscription/credit-card']);
  });

  it('PIX: não pede cartão e não chama a rota do cartão', async () => {
    const user = userEvent.setup();
    const api = mockSubscriptionApi({ 'POST /subscription': CREATED });
    renderWithQueryClient(<SubscriptionPage />);
    await fillClinic(user);

    await user.click(screen.getByRole('button', { name: 'PIX' }));
    expect(screen.queryByPlaceholderText('Número do cartão')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Assinar agora' }));

    expect(await screen.findByText(/Assim que o pagamento PIX for confirmado/)).toBeInTheDocument();
    expect(api.sent('POST', '/subscription')[0].body).toMatchObject({ plan: 'professional', billingCycle: 'monthly', billingType: 'PIX' });
    expect(api.sent('POST', '/subscription/credit-card')).toHaveLength(0);
  });

  it('recusa ao criar a assinatura: mostra o motivo, não envia o cartão e não anuncia sucesso', async () => {
    const user = userEvent.setup();
    const api = mockSubscriptionApi({
      'POST /subscription': apiError(409, 'CONFLICT', 'Esta clínica já possui uma assinatura ativa ou em trial.'),
    });
    renderWithQueryClient(<SubscriptionPage />);
    await fillClinic(user);
    await fillCard(user);

    await user.click(screen.getByRole('button', { name: 'Assinar agora' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Esta clínica já possui uma assinatura ativa ou em trial.');
    expect(api.sent('POST', '/subscription/credit-card')).toHaveLength(0);
    expect(screen.queryByText(/Assinatura criada/)).not.toBeInTheDocument();
  });

  it('cartão recusado depois de a assinatura ser criada: mostra o motivo e não anuncia sucesso', async () => {
    const user = userEvent.setup();
    const api = mockSubscriptionApi({
      'POST /subscription': CREATED,
      'POST /subscription/credit-card': apiError(409, 'CONFLICT', 'Cartão recusado pela operadora.'),
    });
    renderWithQueryClient(<SubscriptionPage />);
    await fillClinic(user);
    await fillCard(user);

    await user.click(screen.getByRole('button', { name: 'Assinar agora' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Cartão recusado pela operadora.');
    expect(screen.queryByText(/Assinatura criada/)).not.toBeInTheDocument();
    await waitFor(() => expect(api.sent('POST', '/subscription/credit-card')).toHaveLength(1));
  });

  it('servidor fora do ar no envio: frase própria, sem erro técnico na tela', async () => {
    const user = userEvent.setup();
    const api = mockSubscriptionApi();
    renderWithQueryClient(<SubscriptionPage />);
    await fillClinic(user);
    await user.click(screen.getByRole('button', { name: 'PIX' }));

    api.fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await user.click(screen.getByRole('button', { name: 'Assinar agora' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível processar a assinatura.');
  });
});
