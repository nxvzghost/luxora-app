import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithQueryClient, mockFailingFetch } from '../support/render-with-query';
import { apiError, fakeToken, mockApi, type MockReply, type MockRequest } from '../support/mock-api';
import { useAuthStore } from '@/lib/stores/auth.store';
import FinanceiroPage from '@/app/financeiro/page';

/**
 * FinanceiroPage — Fase 9.2/9.4 (AD-014, AD-020) e Tarefa 05 da auditoria:
 * criar cobrança a partir das sessões realizadas, enviar, registrar o
 * pagamento, acompanhar o estado e estornar.
 */

const BILLING = { id: 'billing-1', patientId: 'patient-1', amount: 200, dueDate: '2026-08-10T00:00:00.000Z', state: 'Criada' };
const SESSION_1 = { id: 'session-1', appointmentId: 'a1', patientId: 'patient-1', therapistId: 't1', state: 'Realizada', scheduledAt: '2026-10-01T17:00:00.000Z' };
const SESSION_2 = { ...SESSION_1, id: 'session-2', appointmentId: 'a2', scheduledAt: '2026-10-08T17:00:00.000Z' };
const PAYMENT = { id: 'payment-1', billingId: 'billing-1', amount: 200, state: 'Confirmado' };

type Routes = Record<string, MockReply | ((request: MockRequest) => MockReply)>;

function mockFinance(overrides: Routes = {}, billings: Array<typeof BILLING & { paymentState?: string | null; overdue?: boolean }> = [BILLING]) {
  return mockApi({
    'GET /billings': { body: { data: billings } },
    'GET /patients': { body: { data: [{ id: 'patient-1', name: 'Paciente Teste', phone: '+5541900000000', state: 'Ativo', billingPolicyOverride: null }] } },
    'GET /therapists': { body: { data: [{ id: 't1', name: 'Dra. Marta', specialty: null }] } },
    'GET /sessions': { body: { data: [SESSION_1, SESSION_2] } },
    'GET /billings/:id/payments': { body: { data: [] } },
    'GET /notifications/unread-count': { body: { count: 0 } },
    ...overrides,
  });
}

function signIn(role: 'admin' | 'therapist' = 'admin') {
  useAuthStore.setState({ accessToken: fakeToken(role), refreshToken: 'fake-refresh' });
}

beforeEach(() => signIn());

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ accessToken: null, refreshToken: null });
});

describe('FinanceiroPage — carregamento', () => {
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

  it('sem cobranças: explica de onde elas nascem', async () => {
    mockFinance({}, []);
    renderWithQueryClient(<FinanceiroPage />);

    expect(await screen.findByText(/nenhuma cobrança gerada ainda/i)).toHaveTextContent(/confirme a consulta na Agenda/i);
  });

  it('perfil terapeuta vê as cobranças, sem as ações que a API reserva ao admin', async () => {
    signIn('therapist');
    mockFinance();
    renderWithQueryClient(<FinanceiroPage />);
    await screen.findByText('Paciente Teste');

    expect(screen.queryByRole('button', { name: 'Nova cobrança' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enviar' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pagamento' })).toBeInTheDocument();
  });

  it('cobrança com pagamento estornado aparece como tal e não entra no total recebido', async () => {
    mockFinance({}, [
      { ...BILLING, id: 'billing-paga', state: 'Quitada', paymentState: 'Confirmado' },
      { ...BILLING, id: 'billing-estornada', amount: 300, state: 'Quitada', paymentState: 'Estornado' },
    ]);
    renderWithQueryClient(<FinanceiroPage />);

    expect(await screen.findByText('Pagamento estornado')).toBeInTheDocument();
    expect(screen.getAllByText('Quitada')).toHaveLength(1);
    // Faturado soma as duas (R$ 500,00); recebido, só a que não foi estornada.
    expect(screen.getByText('Recebido').parentElement).toHaveTextContent('R$ 200,00');
    expect(screen.getByText('Total faturado').parentElement).toHaveTextContent('R$ 500,00');
  });

  it('cobrança em aberto com pagamento divergente é sinalizada na lista', async () => {
    mockFinance({}, [{ ...BILLING, state: 'Enviada', paymentState: 'Divergente' }]);
    renderWithQueryClient(<FinanceiroPage />);

    expect(await screen.findByText('Pagamento divergente')).toBeInTheDocument();
    expect(screen.getByText('Enviada')).toBeInTheDocument();
  });

  it('conta e sinaliza as cobranças em atraso pelo que a API informa; quitada com vencimento antigo não entra', async () => {
    mockFinance({}, [
      { ...BILLING, id: 'enviada-vencida', state: 'Enviada', overdue: true },
      { ...BILLING, id: 'criada-vencida', state: 'Criada', overdue: true },
      { ...BILLING, id: 'atrasada', state: 'Atrasada', overdue: true },
      { ...BILLING, id: 'criada-a-vencer', state: 'Criada', dueDate: '2099-01-10T00:00:00.000Z', overdue: false },
      { ...BILLING, id: 'quitada-antiga', state: 'Quitada', dueDate: '2020-01-10T00:00:00.000Z', overdue: false, paymentState: 'Confirmado' },
    ]);
    renderWithQueryClient(<FinanceiroPage />);

    await waitFor(() => expect(screen.getByText('Cobranças em atraso').parentElement).toHaveTextContent('3'));
    // A que já está no estado Atrasada mostra o estado; as outras duas ganham o aviso.
    expect(screen.getAllByText('Em atraso')).toHaveLength(2);
    expect(screen.getByText('Atrasada')).toBeInTheDocument();
    const paid = screen.getByText('Quitada').closest('li') as HTMLElement;
    expect(within(paid).queryByText('Em atraso')).not.toBeInTheDocument();
  });

  it('não refaz a conta pela data: quem decide o atraso é a API, a mesma regra do Dashboard', async () => {
    mockFinance({}, [{ ...BILLING, state: 'Enviada', dueDate: '2020-01-10T00:00:00.000Z', overdue: false }]);
    renderWithQueryClient(<FinanceiroPage />);

    await screen.findByText('Paciente Teste');
    expect(screen.getByText('Cobranças em atraso').parentElement).toHaveTextContent('0');
    expect(screen.queryByText('Em atraso')).not.toBeInTheDocument();
  });

  it('soma todas as páginas de cobranças, não só a primeira', async () => {
    const page = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => ({ ...BILLING, id: `${prefix}-${i}`, amount: 10 }));
    const api = mockFinance({
      'GET /billings': (request) => ({ body: { data: request.query.get('cursor') ? page(5, 'segunda') : page(100, 'primeira') } }),
    });
    renderWithQueryClient(<FinanceiroPage />);

    await waitFor(() => expect(screen.getByText('Total faturado').parentElement).toHaveTextContent('R$ 1.050,00'));
    const requests = api.sent('GET', '/billings');
    expect(requests).toHaveLength(2);
    expect(requests[0].query.get('limit')).toBe('100');
    expect(requests[1].query.get('cursor')).toBe('primeira-99');
  });
});

describe('FinanceiroPage — criar cobrança', () => {
  async function openForm(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Nova cobrança' }));
    const form = screen.getByRole('form', { name: 'Nova cobrança' });
    await waitFor(() => expect(within(form).getByRole('option', { name: 'Paciente Teste' })).toBeInTheDocument());
    return form;
  }

  it('lista as sessões realizadas e ainda não cobradas do paciente e cria a cobrança com as escolhidas', async () => {
    const user = userEvent.setup();
    const api = mockFinance({ 'POST /billings': { status: 201, body: { ...BILLING, id: 'billing-nova', amount: 450.5 } } });
    renderWithQueryClient(<FinanceiroPage />);
    const form = await openForm(user);

    await user.selectOptions(within(form).getByLabelText('Paciente'), 'patient-1');
    const checkboxes = await within(form).findAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    const sessionsRequest = api.sent('GET', '/sessions')[0];
    expect(sessionsRequest.query.get('state')).toBe('Realizada');
    expect(sessionsRequest.query.get('patientId')).toBe('patient-1');

    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);
    await user.type(within(form).getByLabelText('Valor total (R$)'), '450,50');
    fireEvent.change(within(form).getByLabelText('Vencimento'), { target: { value: '2026-11-10' } });
    await user.click(within(form).getByRole('button', { name: 'Criar cobrança' }));

    await waitFor(() => expect(api.sent('POST', '/billings')).toHaveLength(1));
    expect(api.sent('POST', '/billings')[0].body).toEqual({
      patientId: 'patient-1',
      amount: 450.5,
      dueDate: '2026-11-10',
      sessionIds: ['session-1', 'session-2'],
    });
    expect(await screen.findByRole('status')).toHaveTextContent(/cobrança de R\$\s?450,50 criada para Paciente Teste/i);
  });

  it('paciente sem sessão a cobrar: explica de onde vêm as sessões', async () => {
    const user = userEvent.setup();
    mockFinance({ 'GET /sessions': { body: { data: [] } } });
    renderWithQueryClient(<FinanceiroPage />);
    const form = await openForm(user);

    await user.selectOptions(within(form).getByLabelText('Paciente'), 'patient-1');

    expect(await within(form).findByText(/não tem sessão a cobrar/i)).toHaveTextContent(/depois que a consulta é confirmada/i);
  });

  it('sem sessão marcada ou com valor inválido, não chama a API', async () => {
    const user = userEvent.setup();
    const api = mockFinance();
    renderWithQueryClient(<FinanceiroPage />);
    const form = await openForm(user);
    await user.selectOptions(within(form).getByLabelText('Paciente'), 'patient-1');
    const checkboxes = await within(form).findAllByRole('checkbox');
    await user.type(within(form).getByLabelText('Valor total (R$)'), '0');
    fireEvent.change(within(form).getByLabelText('Vencimento'), { target: { value: '2026-11-10' } });

    await user.click(within(form).getByRole('button', { name: 'Criar cobrança' }));
    expect(within(form).getByRole('alert')).toHaveTextContent(/marque ao menos uma sessão/i);

    await user.click(checkboxes[0]);
    await user.click(within(form).getByRole('button', { name: 'Criar cobrança' }));
    expect(within(form).getByRole('alert')).toHaveTextContent(/valor maior que zero/i);
    expect(api.sent('POST', '/billings')).toHaveLength(0);
  });

  it('sessão já cobrada por outra pessoa (409): mostra a regra e recarrega as sessões', async () => {
    const user = userEvent.setup();
    const api = mockFinance({ 'POST /billings': apiError(409, 'SESSION_ALREADY_BILLED', 'Uma das sessões já está vinculada a outra cobrança.') });
    renderWithQueryClient(<FinanceiroPage />);
    const form = await openForm(user);
    await user.selectOptions(within(form).getByLabelText('Paciente'), 'patient-1');
    await user.click((await within(form).findAllByRole('checkbox'))[0]);
    await user.type(within(form).getByLabelText('Valor total (R$)'), '200');
    fireEvent.change(within(form).getByLabelText('Vencimento'), { target: { value: '2026-11-10' } });
    const before = api.sent('GET', '/sessions').length;

    await user.click(within(form).getByRole('button', { name: 'Criar cobrança' }));

    expect(await within(form).findByRole('alert')).toHaveTextContent(/já está vinculada a outra cobrança/i);
    await waitFor(() => expect(api.sent('GET', '/sessions').length).toBeGreaterThan(before));
  });
});

describe('FinanceiroPage — enviar cobrança', () => {
  it('pede confirmação antes de mandar mensagem ao paciente e só então chama POST /billings/:id/send', async () => {
    const user = userEvent.setup();
    const api = mockFinance({ 'POST /billings/:id/send': { status: 201, body: { ...BILLING, state: 'Enviada' } } });
    renderWithQueryClient(<FinanceiroPage />);

    await user.click(await screen.findByRole('button', { name: /^enviar$/i }));
    const dialog = screen.getByRole('dialog', { name: /enviar esta cobrança/i });
    expect(dialog).toHaveTextContent(/Paciente Teste recebe pelo WhatsApp/i);
    expect(api.sent('POST', '/billings/:id/send')).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Enviar cobrança' }));

    await waitFor(() => expect(api.sent('POST', '/billings/:id/send')).toHaveLength(1));
    expect(api.sent('POST', '/billings/:id/send')[0].path).toBe('/billings/billing-1/send');
    expect(await screen.findByRole('status')).toHaveTextContent(/enviada para a fila do WhatsApp/i);
  });

  it('cobrança já enviada não oferece "Enviar" de novo', async () => {
    mockFinance({}, [{ ...BILLING, state: 'Enviada' }]);
    renderWithQueryClient(<FinanceiroPage />);

    await screen.findByText('Paciente Teste');
    expect(screen.queryByRole('button', { name: /^enviar$/i })).not.toBeInTheDocument();
  });

  it('erro ao enviar aparece dentro da confirmação', async () => {
    const user = userEvent.setup();
    mockFinance({ 'POST /billings/:id/send': apiError(409, 'CONFLICT', 'Não é possível enviar.') });
    renderWithQueryClient(<FinanceiroPage />);

    await user.click(await screen.findByRole('button', { name: /^enviar$/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Enviar cobrança' }));

    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(/não é possível enviar/i);
  });

  it('clínica sem WhatsApp conectado: diz que nada foi enviado e onde conectar', async () => {
    const user = userEvent.setup();
    mockFinance({ 'POST /billings/:id/send': apiError(409, 'WHATSAPP_NOT_CONNECTED', 'A clínica ainda não conectou o WhatsApp.') });
    renderWithQueryClient(<FinanceiroPage />);

    await user.click(await screen.findByRole('button', { name: /^enviar$/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Enviar cobrança' }));

    const alert = await within(screen.getByRole('dialog')).findByRole('alert');
    expect(alert).toHaveTextContent(/nada foi enviado/i);
    expect(alert).toHaveTextContent(/Configurações/);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('FinanceiroPage — pagamento e estorno', () => {
  async function openPayment(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Pagamento' }));
    return screen.getByRole('dialog', { name: /pagamento — Paciente Teste/i });
  }

  it('registrar pagamento: valor da cobrança já preenchido, POST /payments com Idempotency-Key', async () => {
    const user = userEvent.setup();
    const api = mockFinance({ 'POST /payments': { status: 201, body: PAYMENT } }, [{ ...BILLING, state: 'Enviada' }]);
    renderWithQueryClient(<FinanceiroPage />);
    const dialog = await openPayment(user);

    expect(await within(dialog).findByLabelText('Valor recebido (R$)')).toHaveValue('200');
    await user.click(within(dialog).getByRole('button', { name: 'Registrar pagamento' }));

    await waitFor(() => expect(api.sent('POST', '/payments')).toHaveLength(1));
    const request = api.sent('POST', '/payments')[0];
    expect(request.body).toEqual({ billingId: 'billing-1', amount: 200 });
    expect(request.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByRole('status')).toHaveTextContent(/a cobrança foi quitada/i);
  });

  it('tentar de novo depois de uma falha reutiliza a mesma Idempotency-Key — nunca dois pagamentos', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const api = mockFinance({
      'POST /payments': () => (++attempts === 1 ? apiError(503, 'SERVICE_UNAVAILABLE', 'indisponível') : { status: 201, body: PAYMENT }),
    });
    renderWithQueryClient(<FinanceiroPage />);
    const dialog = await openPayment(user);
    await within(dialog).findByLabelText('Valor recebido (R$)');

    await user.click(within(dialog).getByRole('button', { name: 'Registrar pagamento' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/não foi possível registrar o pagamento/i);
    await user.click(within(dialog).getByRole('button', { name: 'Registrar pagamento' }));

    await waitFor(() => expect(api.sent('POST', '/payments')).toHaveLength(2));
    const [first, second] = api.sent('POST', '/payments');
    expect(second.headers['Idempotency-Key']).toBe(first.headers['Idempotency-Key']);
  });

  it('valor diferente do cobrado: pede um segundo passo antes de registrar como divergente', async () => {
    const user = userEvent.setup();
    const api = mockFinance({ 'POST /payments': { status: 201, body: { ...PAYMENT, amount: 150, state: 'Divergente' } } });
    renderWithQueryClient(<FinanceiroPage />);
    const dialog = await openPayment(user);
    const input = await within(dialog).findByLabelText('Valor recebido (R$)');

    await user.clear(input);
    await user.type(input, '150');
    await user.click(within(dialog).getByRole('button', { name: 'Registrar pagamento' }));

    expect(api.sent('POST', '/payments')).toHaveLength(0);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/diferente do da cobrança \(R\$\s200,00\)/i);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/não pode ser corrigido pelo painel/i);

    await user.click(within(dialog).getByRole('button', { name: 'Registrar como divergente' }));

    await waitFor(() => expect(api.sent('POST', '/payments')[0].body).toEqual({ billingId: 'billing-1', amount: 150 }));
    expect(await screen.findByRole('status')).toHaveTextContent(/registrado como divergente/i);
  });

  it('corrigir o valor depois do aviso de divergência volta ao registro normal', async () => {
    const user = userEvent.setup();
    const api = mockFinance({ 'POST /payments': { status: 201, body: PAYMENT } });
    renderWithQueryClient(<FinanceiroPage />);
    const dialog = await openPayment(user);
    const input = await within(dialog).findByLabelText('Valor recebido (R$)');

    await user.clear(input);
    await user.type(input, '20');
    await user.click(within(dialog).getByRole('button', { name: 'Registrar pagamento' }));
    expect(within(dialog).getByRole('button', { name: 'Registrar como divergente' })).toBeInTheDocument();

    await user.type(input, '0');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Registrar pagamento' }));

    await waitFor(() => expect(api.sent('POST', '/payments')[0].body).toEqual({ billingId: 'billing-1', amount: 200 }));
  });

  it('cobrança paga: mostra o pagamento e o estorno exige um segundo passo de confirmação', async () => {
    const user = userEvent.setup();
    const api = mockFinance(
      { 'GET /billings/:id/payments': { body: { data: [PAYMENT] } }, 'POST /payments/:id/refund': { status: 201, body: { ...PAYMENT, state: 'Estornado' } } },
      [{ ...BILLING, state: 'Quitada' }],
    );
    renderWithQueryClient(<FinanceiroPage />);
    const dialog = await openPayment(user);

    expect(await within(dialog).findByText(/Confirmado/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Valor recebido (R$)')).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Estornar pagamento' }));
    expect(api.sent('POST', '/payments/:id/refund')).toHaveLength(0);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/não pode ser desfeito/i);

    await user.click(within(dialog).getByRole('button', { name: 'Confirmar estorno' }));

    await waitFor(() => expect(api.sent('POST', '/payments/:id/refund')).toHaveLength(1));
    expect(api.sent('POST', '/payments/:id/refund')[0].path).toBe('/payments/payment-1/refund');
    expect(await screen.findByRole('status')).toHaveTextContent(/estornado/i);
  });

  it('pagamento já estornado: só informa o estado, sem ação', async () => {
    const user = userEvent.setup();
    mockFinance({ 'GET /billings/:id/payments': { body: { data: [{ ...PAYMENT, state: 'Estornado' }] } } }, [{ ...BILLING, state: 'Quitada' }]);
    renderWithQueryClient(<FinanceiroPage />);
    const dialog = await openPayment(user);

    expect(await within(dialog).findByText(/Estornado/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /estornar/i })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Fechar' })).toBeInTheDocument();
  });

  it('erro no estorno aparece na janela, que continua aberta', async () => {
    const user = userEvent.setup();
    mockFinance(
      { 'GET /billings/:id/payments': { body: { data: [PAYMENT] } }, 'POST /payments/:id/refund': apiError(500, 'INTERNAL_SERVER_ERROR', 'erro') },
      [{ ...BILLING, state: 'Quitada' }],
    );
    renderWithQueryClient(<FinanceiroPage />);
    const dialog = await openPayment(user);
    await within(dialog).findByText(/Confirmado/);

    await user.click(within(dialog).getByRole('button', { name: 'Estornar pagamento' }));
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar estorno' }));

    await waitFor(() => expect(within(dialog).getAllByRole('alert').some((alert) => /não foi possível estornar/i.test(alert.textContent ?? ''))).toBe(true));
  });

  it('perfil terapeuta consulta o pagamento, sem poder registrar nem estornar', async () => {
    signIn('therapist');
    const user = userEvent.setup();
    mockFinance({ 'GET /billings/:id/payments': { body: { data: [PAYMENT] } } }, [{ ...BILLING, state: 'Quitada' }]);
    renderWithQueryClient(<FinanceiroPage />);
    const dialog = await openPayment(user);

    expect(await within(dialog).findByText(/só um administrador/i)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /estornar/i })).not.toBeInTheDocument();
  });
});
