import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithQueryClient, mockFailingFetch } from '../support/render-with-query';
import { apiError, fakeToken, mockApi, type MockReply, type MockRequest } from '../support/mock-api';
import { useAuthStore } from '@/lib/stores/auth.store';
import { todayInputValue } from '@/components/slot-picker';
import AgendaPage from '@/app/agenda/page';

/**
 * AgendaPage — Fase 9.2/9.3 (AD-014, AD-015) e Tarefa 05 da auditoria:
 * o ciclo completo da consulta pela tela (criar, confirmar, remarcar,
 * cancelar), respeitando disponibilidade e conflitos.
 */

const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000);
const TOMORROW_DAY = todayInputValue(TOMORROW);
const slotAt = (hour: number) => {
  const start = new Date(`${TOMORROW_DAY}T${String(hour).padStart(2, '0')}:00:00`);
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 50 * 60_000).toISOString() };
};
const SLOT_14 = slotAt(14);
const SLOT_15 = slotAt(15);

const APPOINTMENT = {
  id: 'appt-1',
  patientId: 'patient-1',
  therapistId: 'therapist-1',
  scheduledAt: SLOT_14.startsAt,
  state: 'Reservada',
  recurring: false,
};

type Routes = Record<string, MockReply | ((request: MockRequest) => MockReply)>;

function mockAgenda(overrides: Routes = {}, appointments: Array<typeof APPOINTMENT> = [APPOINTMENT]) {
  return mockApi({
    'GET /appointments': { body: { data: appointments } },
    'GET /patients': {
      body: {
        data: [
          { id: 'patient-1', name: 'Ana Souza', phone: '+5541999990001', state: 'Ativo', billingPolicyOverride: null },
          { id: 'patient-2', name: 'Paciente com Alta', phone: '+5541999990002', state: 'Alta', billingPolicyOverride: null },
        ],
      },
    },
    'GET /therapists': { body: { data: [{ id: 'therapist-1', name: 'Dra. Marta', specialty: null }] } },
    'GET /therapists/:id/availability': { body: { data: [SLOT_14, SLOT_15] } },
    'GET /notifications/unread-count': { body: { count: 0 } },
    ...overrides,
  });
}

beforeEach(() => {
  useAuthStore.setState({ accessToken: fakeToken('admin'), refreshToken: 'fake-refresh' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ accessToken: null, refreshToken: null });
});

describe('AgendaPage — carregamento', () => {
  it('exibe mensagem de erro visível quando a busca de agendamentos falha', async () => {
    vi.stubGlobal('fetch', mockFailingFetch());
    renderWithQueryClient(<AgendaPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/não foi possível carregar a agenda/i);
    });
  });

  it('não exibe a mensagem de "nenhuma consulta" quando há erro (evita mensagem enganosa)', async () => {
    vi.stubGlobal('fetch', mockFailingFetch());
    renderWithQueryClient(<AgendaPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.queryByText(/nenhuma consulta/i)).not.toBeInTheDocument();
  });

  it('mostra cada consulta com paciente, terapeuta e estado — não os ids', async () => {
    mockAgenda();
    renderWithQueryClient(<AgendaPage />);

    const row = (await screen.findByText(/Ana Souza · Dra\. Marta/)).closest('li') as HTMLElement;
    expect(within(row).getByText('Reservado')).toBeInTheDocument();
  });

  it('período sem consulta: diz isso, sem parecer erro', async () => {
    mockAgenda({}, []);
    renderWithQueryClient(<AgendaPage />);

    expect(await screen.findByText(/nenhuma consulta neste período/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('"Próxima semana" busca os sete dias seguintes', async () => {
    const api = mockAgenda();
    renderWithQueryClient(<AgendaPage />);
    await screen.findByText(/Ana Souza/);
    const firstFrom = new Date(api.sent('GET', '/appointments')[0].query.get('from') as string).getTime();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Próxima semana' }));

    await waitFor(() => expect(api.sent('GET', '/appointments').length).toBeGreaterThan(1));
    const calls = api.sent('GET', '/appointments');
    const nextFrom = new Date(calls[calls.length - 1].query.get('from') as string).getTime();
    expect(nextFrom - firstFrom).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('AgendaPage — ações de cada estado', () => {
  it('consulta já confirmada não oferece "Confirmar", mas pode ser remarcada ou cancelada', async () => {
    mockAgenda({}, [{ ...APPOINTMENT, state: 'Confirmada' }]);
    renderWithQueryClient(<AgendaPage />);
    await screen.findByText(/Ana Souza/);

    expect(screen.queryByRole('button', { name: 'Confirmar' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remarcar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeInTheDocument();
  });

  it('confirmar consulta chama POST /appointments/:id/confirm e avisa que deu certo', async () => {
    const api = mockAgenda({ 'POST /appointments/:id/confirm': { status: 201, body: { ...APPOINTMENT, state: 'Confirmada' } } });
    renderWithQueryClient(<AgendaPage />);

    await userEvent.setup().click(await screen.findByRole('button', { name: /^confirmar$/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/consulta de Ana Souza confirmada/i);
    expect(api.sent('POST', '/appointments/:id/confirm')[0].path).toBe('/appointments/appt-1/confirm');
  });

  it('erro ao confirmar exibe a regra de negócio devolvida, sem quebrar a lista', async () => {
    mockAgenda({ 'POST /appointments/:id/confirm': apiError(409, 'CONFLICT', 'Não é possível confirmar.') });
    renderWithQueryClient(<AgendaPage />);

    await userEvent.setup().click(await screen.findByRole('button', { name: /^confirmar$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/não é possível confirmar/i);
    expect(screen.getByText(/Ana Souza/)).toBeInTheDocument();
  });

  it('cancelar pede confirmação: "Voltar" não chama a API', async () => {
    const user = userEvent.setup();
    const api = mockAgenda({ 'POST /appointments/:id/cancel': { status: 201, body: { ...APPOINTMENT, state: 'Cancelada' } } });
    renderWithQueryClient(<AgendaPage />);

    await user.click(await screen.findByRole('button', { name: /^cancelar$/i }));
    const dialog = screen.getByRole('dialog', { name: /cancelar esta consulta/i });
    expect(dialog).toHaveTextContent(/Ana Souza/);
    expect(dialog).toHaveTextContent(/não pode ser desfeito/i);

    await user.click(within(dialog).getByRole('button', { name: 'Voltar' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.sent('POST', '/appointments/:id/cancel')).toHaveLength(0);
  });

  it('cancelar confirmado chama POST /appointments/:id/cancel', async () => {
    const user = userEvent.setup();
    const api = mockAgenda({ 'POST /appointments/:id/cancel': { status: 201, body: { ...APPOINTMENT, state: 'Cancelada' } } });
    renderWithQueryClient(<AgendaPage />);

    await user.click(await screen.findByRole('button', { name: /^cancelar$/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar consulta' }));

    await waitFor(() => expect(api.sent('POST', '/appointments/:id/cancel')).toHaveLength(1));
    expect(await screen.findByRole('status')).toHaveTextContent(/cancelada/i);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('erro ao cancelar aparece dentro da confirmação, que continua aberta', async () => {
    const user = userEvent.setup();
    mockAgenda({ 'POST /appointments/:id/cancel': apiError(409, 'CONFLICT', 'Não é possível cancelar.') });
    renderWithQueryClient(<AgendaPage />);

    await user.click(await screen.findByRole('button', { name: /^cancelar$/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar consulta' }));

    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(/não é possível cancelar/i);
  });
});

describe('AgendaPage — criar consulta', () => {
  async function openForm(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Nova consulta' }));
    const form = screen.getByRole('form', { name: 'Nova consulta' });
    await waitFor(() => expect(within(form).getByRole('option', { name: 'Ana Souza' })).toBeInTheDocument());
    return form;
  }

  async function fillUntilSlot(user: ReturnType<typeof userEvent.setup>, form: HTMLElement) {
    await user.selectOptions(within(form).getByLabelText('Paciente'), 'patient-1');
    await user.selectOptions(within(form).getByLabelText('Terapeuta'), 'therapist-1');
    fireEvent.change(within(form).getByLabelText('Dia'), { target: { value: TOMORROW_DAY } });
    await waitFor(() => expect(within(form).getByLabelText('Horário')).toBeInTheDocument());
  }

  it('só oferece pacientes que podem ser atendidos (sem alta nem inativos)', async () => {
    mockAgenda();
    renderWithQueryClient(<AgendaPage />);
    const form = await openForm(userEvent.setup());

    expect(within(form).queryByRole('option', { name: 'Paciente com Alta' })).not.toBeInTheDocument();
  });

  it('busca os horários livres do terapeuta no dia escolhido e cria a consulta no horário selecionado', async () => {
    const user = userEvent.setup();
    const api = mockAgenda({
      'POST /appointments': (request) => ({ status: 201, body: { ...APPOINTMENT, id: 'appt-novo', scheduledAt: (request.body as { scheduledAt: string }).scheduledAt } }),
    });
    renderWithQueryClient(<AgendaPage />);
    const form = await openForm(user);
    await fillUntilSlot(user, form);

    const availability = api.sent('GET', '/therapists/:id/availability').pop() as MockRequest;
    expect(availability.path).toBe('/therapists/therapist-1/availability');
    expect(new Date(availability.query.get('from') as string).toISOString()).toBe(new Date(`${TOMORROW_DAY}T00:00:00`).toISOString());

    await user.selectOptions(within(form).getByLabelText('Horário'), SLOT_15.startsAt);
    await user.selectOptions(within(form).getByLabelText('Modalidade'), 'online');
    await user.click(within(form).getByRole('button', { name: 'Marcar consulta' }));

    await waitFor(() => expect(api.sent('POST', '/appointments')).toHaveLength(1));
    expect(api.sent('POST', '/appointments')[0].body).toEqual({
      patientId: 'patient-1',
      therapistId: 'therapist-1',
      scheduledAt: SLOT_15.startsAt,
      modality: 'online',
    });
    expect(await screen.findByRole('status')).toHaveTextContent(/consulta de Ana Souza marcada/i);
    expect(screen.queryByRole('form', { name: 'Nova consulta' })).not.toBeInTheDocument();
  });

  it('sem horário livre no dia: explica, aponta a disponibilidade e não deixa enviar', async () => {
    const user = userEvent.setup();
    mockAgenda({ 'GET /therapists/:id/availability': { body: { data: [] } } });
    renderWithQueryClient(<AgendaPage />);
    const form = await openForm(user);
    await user.selectOptions(within(form).getByLabelText('Paciente'), 'patient-1');
    await user.selectOptions(within(form).getByLabelText('Terapeuta'), 'therapist-1');

    expect(await within(form).findByText(/sem horário livre neste dia/i)).toBeInTheDocument();
    expect(within(form).getByRole('link', { name: /disponibilidade do terapeuta/i })).toHaveAttribute('href', '/disponibilidade');
    expect(within(form).getByRole('button', { name: 'Marcar consulta' })).toBeDisabled();
  });

  it('horário ocupado por outra pessoa no meio do caminho: avisa, limpa a escolha e recarrega os livres', async () => {
    const user = userEvent.setup();
    const api = mockAgenda({ 'POST /appointments': apiError(409, 'SLOT_NOT_AVAILABLE', 'O horário selecionado não está disponível.') });
    renderWithQueryClient(<AgendaPage />);
    const form = await openForm(user);
    await fillUntilSlot(user, form);
    await user.selectOptions(within(form).getByLabelText('Horário'), SLOT_14.startsAt);
    const fetchesBefore = api.sent('GET', '/therapists/:id/availability').length;

    await user.click(within(form).getByRole('button', { name: 'Marcar consulta' }));

    expect(await within(form).findByRole('alert')).toHaveTextContent(/esse horário não está mais disponível/i);
    expect(within(form).getByLabelText('Horário')).toHaveValue('');
    await waitFor(() => expect(api.sent('GET', '/therapists/:id/availability').length).toBeGreaterThan(fetchesBefore));
  });

  it('corrida no banco (SESSION_CONFLICT) também vira uma frase compreensível', async () => {
    const user = userEvent.setup();
    mockAgenda({ 'POST /appointments': apiError(409, 'SESSION_CONFLICT', 'Conflito de sessão.') });
    renderWithQueryClient(<AgendaPage />);
    const form = await openForm(user);
    await fillUntilSlot(user, form);
    await user.selectOptions(within(form).getByLabelText('Horário'), SLOT_14.startsAt);

    await user.click(within(form).getByRole('button', { name: 'Marcar consulta' }));

    expect(await within(form).findByRole('alert')).toHaveTextContent(/acabou de ocupar esse horário/i);
  });
});

describe('AgendaPage — remarcar', () => {
  it('escolhe um novo horário livre do mesmo terapeuta e chama PATCH /appointments/:id/reschedule', async () => {
    const user = userEvent.setup();
    const api = mockAgenda({
      'PATCH /appointments/:id/reschedule': { body: { ...APPOINTMENT, scheduledAt: SLOT_15.startsAt, state: 'Reagendada' } },
    });
    renderWithQueryClient(<AgendaPage />);

    await user.click(await screen.findByRole('button', { name: 'Remarcar' }));
    const dialog = screen.getByRole('dialog', { name: 'Remarcar consulta' });
    fireEvent.change(within(dialog).getByLabelText('Dia'), { target: { value: TOMORROW_DAY } });
    await user.selectOptions(await within(dialog).findByLabelText('Horário'), SLOT_15.startsAt);
    await user.click(within(dialog).getByRole('button', { name: 'Remarcar' }));

    await waitFor(() => expect(api.sent('PATCH', '/appointments/:id/reschedule')).toHaveLength(1));
    const request = api.sent('PATCH', '/appointments/:id/reschedule')[0];
    expect(request.path).toBe('/appointments/appt-1/reschedule');
    expect(request.body).toEqual({ newScheduledAt: SLOT_15.startsAt });
    expect(await screen.findByRole('status')).toHaveTextContent(/remarcada/i);
  });

  it('sem escolher horário, não chama a API e pede a escolha', async () => {
    const user = userEvent.setup();
    const api = mockAgenda();
    renderWithQueryClient(<AgendaPage />);

    await user.click(await screen.findByRole('button', { name: 'Remarcar' }));
    const dialog = screen.getByRole('dialog', { name: 'Remarcar consulta' });
    await user.click(within(dialog).getByRole('button', { name: 'Remarcar' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent(/escolha o novo dia e horário/i);
    expect(api.sent('PATCH', '/appointments/:id/reschedule')).toHaveLength(0);
  });
});
