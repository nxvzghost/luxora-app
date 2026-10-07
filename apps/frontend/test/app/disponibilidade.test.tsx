import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithQueryClient } from '../support/render-with-query';
import { apiError, fakeToken, mockApi, type MockReply, type MockRequest } from '../support/mock-api';
import { useAuthStore } from '@/lib/stores/auth.store';
import DisponibilidadePage from '@/app/disponibilidade/page';

/**
 * Tarefa 05 da auditoria — disponibilidade do terapeuta pela tela:
 * horários de atendimento, exceções e horários fixos.
 */

const MONDAY = { dayOfWeek: 1, startTime: '08:00', endTime: '12:00', sessionDurationMinutes: 50 };
const VACATION = { from: '2031-01-10T03:00:00.000Z', to: '2031-01-20T03:00:00.000Z', reason: 'Férias' };

type Routes = Record<string, MockReply | ((request: MockRequest) => MockReply)>;

function mockAvailability(calendar: { windows: unknown[]; exceptions: unknown[] } | 'missing', overrides: Routes = {}) {
  return mockApi({
    'GET /therapists': { body: { data: [{ id: 't1', name: 'Dra. Marta', specialty: null }, { id: 't2', name: 'Dr. Paulo', specialty: null }] } },
    'GET /therapists/:id/availability/calendar':
      calendar === 'missing' ? apiError(404, 'NOT_FOUND', 'Calendário de disponibilidade não encontrado para este terapeuta.') : { body: { therapistId: 't1', ...calendar } },
    'GET /therapists/:id/availability': { body: { data: [] } },
    'GET /recurring-blocks': { body: { data: [] } },
    'GET /patients': { body: { data: [{ id: 'p1', name: 'Ana Souza', phone: '+5541999990001', state: 'Ativo', billingPolicyOverride: null }] } },
    'GET /clinic': { body: { name: 'Clínica', defaultBillingPolicy: 'per_session', cancellationHoursLimit: null, defaultSessionDurationMinutes: 45, pixKey: null, payeeName: null } },
    'GET /notifications/unread-count': { body: { count: 0 } },
    ...overrides,
  });
}

function signIn(role: 'admin' | 'therapist' = 'admin') {
  useAuthStore.setState({ accessToken: fakeToken(role), refreshToken: 'refresh' });
}

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ accessToken: null, refreshToken: null });
});

describe('DisponibilidadePage — horários de atendimento', () => {
  it('mostra os horários já gravados do terapeuta', async () => {
    signIn();
    mockAvailability({ windows: [MONDAY], exceptions: [] });
    renderWithQueryClient(<DisponibilidadePage />);

    const form = await screen.findByRole('form', { name: 'Horários de atendimento' });
    expect(within(form).getByLabelText('Dia')).toHaveValue('1');
    expect(within(form).getByLabelText('Início')).toHaveValue('08:00');
    expect(within(form).getByLabelText('Fim')).toHaveValue('12:00');
    expect(within(form).getByRole('button', { name: 'Salvar horários' })).toBeDisabled();
  });

  it('terapeuta sem calendário (404) aparece como "nada definido", não como erro', async () => {
    signIn();
    mockAvailability('missing');
    renderWithQueryClient(<DisponibilidadePage />);

    expect(await screen.findByText(/nenhum horário definido/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('adicionar um horário usa a duração padrão da clínica e salva a lista completa', async () => {
    signIn();
    const user = userEvent.setup();
    const api = mockAvailability({ windows: [MONDAY], exceptions: [] }, {
      'PUT /therapists/:id/availability': (request) => ({ body: { therapistId: 't1', windows: (request.body as { windows: unknown[] }).windows, exceptions: [] } }),
    });
    renderWithQueryClient(<DisponibilidadePage />);
    const form = await screen.findByRole('form', { name: 'Horários de atendimento' });
    await waitFor(() => expect(api.sent('GET', '/clinic')).toHaveLength(1));

    await user.click(within(form).getByRole('button', { name: 'Adicionar horário' }));
    expect(within(form).getByText(/alterações não salvas/i)).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Salvar horários' }));

    await waitFor(() => expect(api.sent('PUT', '/therapists/:id/availability')).toHaveLength(1));
    const request = api.sent('PUT', '/therapists/:id/availability')[0];
    expect(request.path).toBe('/therapists/t1/availability');
    expect(request.body).toEqual({ windows: [MONDAY, { dayOfWeek: 1, startTime: '08:00', endTime: '12:00', sessionDurationMinutes: 45 }] });
    expect(await within(form).findByRole('status')).toHaveTextContent(/horários de atendimento salvos/i);
  });

  it('depois de salvar, não acusa alteração pendente quando a leitura devolve as chaves em outra ordem', async () => {
    signIn();
    const user = userEvent.setup();
    // O banco (jsonb) reordena as chaves na leitura; a resposta da gravação vem na ordem enviada.
    let stored: unknown[] = [];
    const api = mockAvailability({ windows: [], exceptions: [] }, {
      'GET /therapists/:id/availability/calendar': () => ({ body: { therapistId: 't1', windows: stored, exceptions: [] } }),
      'PUT /therapists/:id/availability': (request) => {
        const windows = (request.body as { windows: (typeof MONDAY)[] }).windows;
        stored = windows.map((w) => ({ endTime: w.endTime, dayOfWeek: w.dayOfWeek, startTime: w.startTime, sessionDurationMinutes: w.sessionDurationMinutes }));
        return { body: { therapistId: 't1', windows, exceptions: [] } };
      },
    });
    renderWithQueryClient(<DisponibilidadePage />);
    const form = await screen.findByRole('form', { name: 'Horários de atendimento' });

    await user.click(within(form).getByRole('button', { name: 'Adicionar horário' }));
    await user.click(within(form).getByRole('button', { name: 'Salvar horários' }));

    expect(await within(form).findByRole('status')).toHaveTextContent(/horários de atendimento salvos/i);
    await waitFor(() => expect(api.sent('GET', '/therapists/:id/availability/calendar').length).toBeGreaterThan(1));
    await waitFor(() => expect(within(form).queryByText(/alterações não salvas/i)).not.toBeInTheDocument());
    expect(within(form).getByRole('button', { name: 'Salvar horários' })).toBeDisabled();
  });

  it('fim antes do início é barrado na tela, sem chamar a API', async () => {
    signIn();
    const user = userEvent.setup();
    const api = mockAvailability({ windows: [MONDAY], exceptions: [] });
    renderWithQueryClient(<DisponibilidadePage />);
    const form = await screen.findByRole('form', { name: 'Horários de atendimento' });

    fireEvent.change(within(form).getByLabelText('Fim'), { target: { value: '07:00' } });
    await user.click(within(form).getByRole('button', { name: 'Salvar horários' }));

    expect(within(form).getByRole('alert')).toHaveTextContent(/o fim precisa ser depois do início/i);
    expect(api.sent('PUT', '/therapists/:id/availability')).toHaveLength(0);
  });

  it('remover um horário e salvar envia a lista sem ele', async () => {
    signIn();
    const user = userEvent.setup();
    const api = mockAvailability({ windows: [MONDAY, { ...MONDAY, dayOfWeek: 3 }], exceptions: [] }, {
      'PUT /therapists/:id/availability': (request) => ({ body: { therapistId: 't1', windows: (request.body as { windows: unknown[] }).windows, exceptions: [] } }),
    });
    renderWithQueryClient(<DisponibilidadePage />);
    const form = await screen.findByRole('form', { name: 'Horários de atendimento' });

    await user.click(within(form).getByRole('button', { name: 'Remover horário 1' }));
    await user.click(within(form).getByRole('button', { name: 'Salvar horários' }));

    await waitFor(() => expect(api.sent('PUT', '/therapists/:id/availability')).toHaveLength(1));
    expect(api.sent('PUT', '/therapists/:id/availability')[0].body).toEqual({ windows: [{ ...MONDAY, dayOfWeek: 3 }] });
  });

  it('perfil terapeuta vê os horários, mas não tem como alterá-los', async () => {
    signIn('therapist');
    mockAvailability({ windows: [MONDAY], exceptions: [VACATION] });
    renderWithQueryClient(<DisponibilidadePage />);
    const form = await screen.findByRole('form', { name: 'Horários de atendimento' });

    expect(within(form).getByLabelText('Início')).toBeDisabled();
    expect(within(form).queryByRole('button', { name: 'Salvar horários' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Nova exceção' })).not.toBeInTheDocument();
    expect(screen.getByText(/só podem ser alterados por um administrador/i)).toBeInTheDocument();
    // Horário fixo o terapeuta pode criar, como na API.
    expect(screen.getByRole('form', { name: 'Novo horário fixo' })).toBeInTheDocument();
  });

  it('trocar de terapeuta carrega o calendário do outro', async () => {
    signIn();
    const api = mockAvailability({ windows: [MONDAY], exceptions: [] });
    renderWithQueryClient(<DisponibilidadePage />);
    await screen.findByRole('form', { name: 'Horários de atendimento' });

    await userEvent.setup().selectOptions(screen.getByLabelText('Terapeuta'), 't2');

    await waitFor(() => expect(api.sent('GET', '/therapists/:id/availability/calendar').some((request) => request.path.includes('/t2/'))).toBe(true));
  });
});

describe('DisponibilidadePage — exceções', () => {
  it('adicionar uma exceção envia as que já existiam junto — a rota substitui a lista inteira', async () => {
    signIn();
    const user = userEvent.setup();
    const api = mockAvailability({ windows: [MONDAY], exceptions: [VACATION] }, {
      'PUT /therapists/:id/availability/exceptions': (request) => ({ body: { therapistId: 't1', windows: [MONDAY], exceptions: (request.body as { exceptions: unknown[] }).exceptions } }),
    });
    renderWithQueryClient(<DisponibilidadePage />);
    const form = await screen.findByRole('form', { name: 'Nova exceção' });

    fireEvent.change(within(form).getByLabelText('De'), { target: { value: '2031-03-10T08:00' } });
    fireEvent.change(within(form).getByLabelText('Até'), { target: { value: '2031-03-10T18:00' } });
    await user.type(within(form).getByLabelText('Motivo (opcional)'), 'Congresso');
    await user.click(within(form).getByRole('button', { name: 'Adicionar exceção' }));

    await waitFor(() => expect(api.sent('PUT', '/therapists/:id/availability/exceptions')).toHaveLength(1));
    const sent = (api.sent('PUT', '/therapists/:id/availability/exceptions')[0].body as { exceptions: Array<{ from: string; to: string; reason?: string }> }).exceptions;
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(VACATION);
    expect(sent[1]).toEqual({ from: new Date('2031-03-10T08:00').toISOString(), to: new Date('2031-03-10T18:00').toISOString(), reason: 'Congresso' });
  });

  it('fim antes do início é barrado na tela', async () => {
    signIn();
    const api = mockAvailability({ windows: [], exceptions: [] });
    renderWithQueryClient(<DisponibilidadePage />);
    const form = await screen.findByRole('form', { name: 'Nova exceção' });

    fireEvent.change(within(form).getByLabelText('De'), { target: { value: '2031-03-10T18:00' } });
    fireEvent.change(within(form).getByLabelText('Até'), { target: { value: '2031-03-10T08:00' } });
    await userEvent.setup().click(within(form).getByRole('button', { name: 'Adicionar exceção' }));

    expect(within(form).getByRole('alert')).toHaveTextContent(/fim depois do início/i);
    expect(api.sent('PUT', '/therapists/:id/availability/exceptions')).toHaveLength(0);
  });

  it('remover uma exceção pede confirmação e envia a lista sem ela', async () => {
    signIn();
    const user = userEvent.setup();
    const other = { from: '2031-06-01T03:00:00.000Z', to: '2031-06-02T03:00:00.000Z' };
    const api = mockAvailability({ windows: [], exceptions: [VACATION, other] }, {
      'PUT /therapists/:id/availability/exceptions': { body: { therapistId: 't1', windows: [], exceptions: [other] } },
    });
    renderWithQueryClient(<DisponibilidadePage />);
    const section = await screen.findByRole('region', { name: 'Exceções' });

    await user.click(within(section).getAllByRole('button', { name: 'Remover' })[0]);
    const dialog = screen.getByRole('dialog', { name: /remover esta exceção/i });
    expect(api.sent('PUT', '/therapists/:id/availability/exceptions')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Remover exceção' }));

    await waitFor(() => expect(api.sent('PUT', '/therapists/:id/availability/exceptions')).toHaveLength(1));
    expect(api.sent('PUT', '/therapists/:id/availability/exceptions')[0].body).toEqual({ exceptions: [other] });
  });

  it('sem permissão (403) na gravação: explica que o perfil não pode', async () => {
    signIn();
    mockAvailability({ windows: [], exceptions: [] }, { 'PUT /therapists/:id/availability/exceptions': apiError(403, 'FORBIDDEN', 'Ação restrita a: admin.') });
    renderWithQueryClient(<DisponibilidadePage />);
    const form = await screen.findByRole('form', { name: 'Nova exceção' });

    fireEvent.change(within(form).getByLabelText('De'), { target: { value: '2031-03-10T08:00' } });
    fireEvent.change(within(form).getByLabelText('Até'), { target: { value: '2031-03-10T18:00' } });
    await userEvent.setup().click(within(form).getByRole('button', { name: 'Adicionar exceção' }));

    expect(await within(form).findByRole('alert')).toHaveTextContent(/perfil não tem permissão/i);
  });
});

describe('DisponibilidadePage — horários fixos e prévia', () => {
  it('cria um horário fixo para o terapeuta selecionado', async () => {
    signIn();
    const user = userEvent.setup();
    const api = mockAvailability({ windows: [MONDAY], exceptions: [] }, { 'POST /recurring-blocks': { status: 201, body: { id: 'b1' } } });
    renderWithQueryClient(<DisponibilidadePage />);
    const form = await screen.findByRole('form', { name: 'Novo horário fixo' });
    await waitFor(() => expect(within(form).getByRole('option', { name: 'Ana Souza' })).toBeInTheDocument());

    await user.selectOptions(within(form).getByLabelText('Paciente'), 'p1');
    fireEvent.change(within(form).getByLabelText('Primeira ocorrência'), { target: { value: '2031-02-03T09:00' } });
    await user.selectOptions(within(form).getByLabelText('Repete a cada'), '14');
    await user.click(within(form).getByRole('button', { name: 'Criar horário fixo' }));

    await waitFor(() => expect(api.sent('POST', '/recurring-blocks')).toHaveLength(1));
    expect(api.sent('POST', '/recurring-blocks')[0].body).toEqual({
      patientId: 'p1',
      therapistId: 't1',
      firstOccurrence: new Date('2031-02-03T09:00').toISOString(),
      intervalDays: 14,
      modality: 'presencial',
      renewalMode: 'automatic',
    });
  });

  it('a prévia mostra quantos horários a agenda oferece por dia', async () => {
    signIn();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    tomorrow.setHours(10, 0, 0, 0);
    const slot = (offsetMinutes: number) => {
      const start = new Date(tomorrow.getTime() + offsetMinutes * 60_000);
      return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 50 * 60_000).toISOString() };
    };
    mockAvailability({ windows: [MONDAY], exceptions: [] }, { 'GET /therapists/:id/availability': { body: { data: [slot(0), slot(60)] } } });
    renderWithQueryClient(<DisponibilidadePage />);

    const preview = await screen.findByRole('region', { name: 'Horários livres' });
    expect(await within(preview).findByText(/2 horários/)).toBeInTheDocument();
  });

  it('informa que feriados ainda não podem ser cadastrados pela tela', async () => {
    signIn();
    mockAvailability({ windows: [], exceptions: [] });
    renderWithQueryClient(<DisponibilidadePage />);

    expect(await screen.findByText(/a API\s+não tem essa rota/i)).toBeInTheDocument();
  });
});
