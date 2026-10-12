import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithQueryClient } from '../support/render-with-query';
import { apiError, fakeToken, mockApi, type MockReply, type MockRequest } from '../support/mock-api';
import { useAuthStore } from '@/lib/stores/auth.store';
import { browserTimeZone } from '@/lib/clinic-time';
import AgendaPage from '@/app/agenda/page';
import DisponibilidadePage from '@/app/disponibilidade/page';
import FinanceiroPage from '@/app/financeiro/page';
import NotificacoesPage from '@/app/notificacoes/page';

/**
 * AD-039 (ADR-0064) — o painel mostra e lê horários no fuso da CLÍNICA, não
 * no do computador de quem o usa.
 *
 * A clínica destes testes fica em Kiritimati (UTC+14, sem horário de verão):
 * nenhuma máquina que rode a suíte está nesse fuso, então "hora da clínica"
 * e "hora do computador" nunca coincidem. Todos os instantes são escritos em
 * UTC e as horas esperadas estão por extenso — o resultado tem de ser o
 * mesmo com a suíte rodando em UTC, em Brasília ou em Tóquio.
 *
 *   Kiritimati = UTC + 14 h. Meia-noite de lá é 10:00 UTC do dia anterior.
 */
const KIRITIMATI = 'Pacific/Kiritimati';
const HOUR = 60 * 60 * 1000;

type Routes = Record<string, MockReply | ((request: MockRequest) => MockReply)>;

const clinicIn = (timeZone: string) => ({
  name: 'Clínica',
  defaultBillingPolicy: 'per_session',
  cancellationHoursLimit: null,
  defaultSessionDurationMinutes: 50,
  pixKey: null,
  payeeName: null,
  timeZone,
});

/** O relógio de parede de Kiritimati naquele instante, sem depender do `Intl`: é só somar 14 horas. */
function wallClockInKiritimati(instant: string | null): { day: string; time: string } {
  const shifted = new Date(new Date(instant as string).getTime() + 14 * HOUR).toISOString();
  return { day: shifted.slice(0, 10), time: shifted.slice(11, 19) };
}

beforeEach(() => {
  useAuthStore.setState({ accessToken: fakeToken('admin'), refreshToken: 'fake-refresh' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ accessToken: null, refreshToken: null });
});

describe('Agenda — clínica em um fuso diferente do computador', () => {
  // 12:00 UTC de 10/03/2031 é 02:00 de 11/03/2031 em Kiritimati.
  const APPOINTMENT = { id: 'appt-1', patientId: 'patient-1', therapistId: 'therapist-1', scheduledAt: '2031-03-10T12:00:00.000Z', state: 'Reservada', recurring: false };
  // 19:00 UTC de 10/03/2031 é 09:00 de 11/03/2031 em Kiritimati.
  const SLOT = { startsAt: '2031-03-10T19:00:00.000Z', endsAt: '2031-03-10T19:50:00.000Z' };

  function mockAgenda(clinic: MockReply = { body: clinicIn(KIRITIMATI) }, overrides: Routes = {}) {
    return mockApi({
      'GET /clinic': clinic,
      'GET /appointments': { body: { data: [APPOINTMENT] } },
      'GET /patients': { body: { data: [{ id: 'patient-1', name: 'Ana Souza', phone: '+5541999990001', state: 'Ativo', billingPolicyOverride: null }] } },
      'GET /therapists': { body: { data: [{ id: 'therapist-1', name: 'Dra. Marta', specialty: null }] } },
      'GET /therapists/:id/availability': { body: { data: [SLOT] } },
      'GET /notifications/unread-count': { body: { count: 0 } },
      ...overrides,
    });
  }

  it('a consulta aparece no dia e na hora da clínica', async () => {
    mockAgenda();
    renderWithQueryClient(<AgendaPage />);

    await screen.findByRole('note');
    const row = screen.getByText(/Ana Souza · Dra\. Marta/).closest('li') as HTMLElement;
    expect(row).toHaveTextContent(/11\/03/);
    expect(row).toHaveTextContent(/02:00/);
    expect(row).not.toHaveTextContent(/12:00/);
    expect(row).not.toHaveTextContent(/10\/03/);
  });

  it('avisa que os horários estão no fuso da clínica, e diz qual', async () => {
    mockAgenda();
    renderWithQueryClient(<AgendaPage />);

    expect(await screen.findByRole('note')).toHaveTextContent('Horários no fuso da clínica (Pacific/Kiritimati), que é diferente do fuso deste computador.');
  });

  it('os sete dias pedidos à API começam à meia-noite de hoje na clínica', async () => {
    const api = mockAgenda();
    renderWithQueryClient(<AgendaPage />);
    await screen.findByRole('note');

    await waitFor(() => {
      const calls = api.sent('GET', '/appointments');
      expect(wallClockInKiritimati(calls[calls.length - 1].query.get('from')).time).toBe('00:00:00');
    });
    const calls = api.sent('GET', '/appointments');
    const { query } = calls[calls.length - 1];
    const today = wallClockInKiritimati(new Date().toISOString()).day;
    expect(wallClockInKiritimati(query.get('from')).day).toBe(today);
    expect(wallClockInKiritimati(query.get('to')).time).toBe('00:00:00');
    expect(new Date(query.get('to') as string).getTime() - new Date(query.get('from') as string).getTime()).toBe(7 * 24 * HOUR);
  });

  it('"Próxima semana" e "Semana anterior" andam sete dias do calendário da clínica', async () => {
    const user = userEvent.setup();
    const api = mockAgenda();
    renderWithQueryClient(<AgendaPage />);
    await screen.findByRole('note');
    const lastFrom = () => {
      const calls = api.sent('GET', '/appointments');
      return new Date(calls[calls.length - 1].query.get('from') as string).getTime();
    };
    await waitFor(() => expect(wallClockInKiritimati(new Date(lastFrom()).toISOString()).time).toBe('00:00:00'));
    const start = lastFrom();

    await user.click(screen.getByRole('button', { name: 'Próxima semana' }));
    await waitFor(() => expect(lastFrom() - start).toBe(7 * 24 * HOUR));

    await user.click(screen.getByRole('button', { name: 'Semana anterior' }));
    await user.click(screen.getByRole('button', { name: 'Semana anterior' }));
    await waitFor(() => expect(lastFrom() - start).toBe(-7 * 24 * HOUR));

    await user.click(screen.getByRole('button', { name: 'Hoje' }));
    await waitFor(() => expect(lastFrom()).toBe(start));
  });

  it('marcar consulta: o dia escolhido é um dia da clínica, os horários aparecem na hora de lá e o instante enviado é o do horário', async () => {
    const user = userEvent.setup();
    const api = mockAgenda(undefined, { 'POST /appointments': { status: 201, body: { ...APPOINTMENT, id: 'appt-2', scheduledAt: SLOT.startsAt } } });
    renderWithQueryClient(<AgendaPage />);
    await screen.findByRole('note');

    await user.click(screen.getByRole('button', { name: 'Nova consulta' }));
    const form = screen.getByRole('form', { name: 'Nova consulta' });
    await waitFor(() => expect(within(form).getByRole('option', { name: 'Ana Souza' })).toBeInTheDocument());
    // Sem escolher nada, o dia proposto é "hoje" no calendário da clínica.
    expect(within(form).getByLabelText('Dia')).toHaveValue(wallClockInKiritimati(new Date().toISOString()).day);

    await user.selectOptions(within(form).getByLabelText('Paciente'), 'patient-1');
    await user.selectOptions(within(form).getByLabelText('Terapeuta'), 'therapist-1');
    fireEvent.change(within(form).getByLabelText('Dia'), { target: { value: '2031-03-11' } });

    // O dia 11/03 de Kiritimati vai das 10:00 UTC do dia 10 às 10:00 UTC do dia 11.
    await waitFor(() => {
      const calls = api.sent('GET', '/therapists/:id/availability');
      expect(calls[calls.length - 1].query.get('from')).toBe('2031-03-10T10:00:00.000Z');
    });
    const slotCalls = api.sent('GET', '/therapists/:id/availability');
    expect(slotCalls[slotCalls.length - 1].query.get('to')).toBe('2031-03-11T10:00:00.000Z');

    const slot = await within(form).findByLabelText('Horário');
    expect(within(slot).getByRole('option', { name: '09:00 – 09:50' })).toBeInTheDocument();
    await user.selectOptions(slot, SLOT.startsAt);
    await user.click(within(form).getByRole('button', { name: 'Marcar consulta' }));

    await waitFor(() => expect(api.sent('POST', '/appointments')).toHaveLength(1));
    expect(api.sent('POST', '/appointments')[0].body).toMatchObject({ scheduledAt: '2031-03-10T19:00:00.000Z' });
    expect(await screen.findByRole('status')).toHaveTextContent(/marcada para .*11\/03.*09:00/);
  });

  it('clínica no mesmo fuso do computador: nenhum aviso', async () => {
    const api = mockAgenda({ body: clinicIn(browserTimeZone()) });
    renderWithQueryClient(<AgendaPage />);

    await screen.findByText(/Ana Souza · Dra\. Marta/);
    await waitFor(() => expect(api.sent('GET', '/clinic')).toHaveLength(1));
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('se o fuso da clínica não pode ser lido, a tela avisa — e não mostra em silêncio a hora do computador', async () => {
    mockAgenda(apiError(500, 'INTERNAL', 'erro interno'));
    renderWithQueryClient(<AgendaPage />);

    expect(await screen.findByRole('note')).toHaveTextContent(/não foi possível ler o fuso horário da clínica.*fuso deste computador/i);
    expect(screen.getByText(/Ana Souza · Dra\. Marta/)).toBeInTheDocument();
  });

  it('fuso que este navegador não conhece: mesmo aviso, sem quebrar a tela', async () => {
    mockAgenda({ body: clinicIn('Marte/Olimpo') });
    renderWithQueryClient(<AgendaPage />);

    expect(await screen.findByRole('note')).toHaveTextContent(/não foi possível ler o fuso horário da clínica/i);
    expect(screen.getByText(/Ana Souza · Dra\. Marta/)).toBeInTheDocument();
  });
});

describe('Disponibilidade — clínica em um fuso diferente do computador', () => {
  // 10:00 UTC de 10/01/2031 é 00:00 de 11/01/2031 em Kiritimati.
  const VACATION = { from: '2031-01-10T10:00:00.000Z', to: '2031-01-20T10:00:00.000Z', reason: 'Férias' };
  const MONDAY = { dayOfWeek: 1, startTime: '08:00', endTime: '12:00', sessionDurationMinutes: 50 };

  function mockAvailability(exceptions: unknown[], overrides: Routes = {}) {
    return mockApi({
      'GET /clinic': { body: clinicIn(KIRITIMATI) },
      'GET /therapists': { body: { data: [{ id: 't1', name: 'Dra. Marta', specialty: null }] } },
      'GET /therapists/:id/availability/calendar': { body: { therapistId: 't1', windows: [MONDAY], exceptions } },
      'GET /therapists/:id/availability': { body: { data: [] } },
      'GET /recurring-blocks': { body: { data: [] } },
      'GET /patients': { body: { data: [{ id: 'p1', name: 'Ana Souza', phone: '+5541999990001', state: 'Ativo', billingPolicyOverride: null }] } },
      'GET /notifications/unread-count': { body: { count: 0 } },
      ...overrides,
    });
  }

  it('os horários de atendimento são horas de parede: aparecem como foram gravados, sem conversão', async () => {
    mockAvailability([]);
    renderWithQueryClient(<DisponibilidadePage />);

    const form = await screen.findByRole('form', { name: 'Horários de atendimento' });
    expect(within(form).getByLabelText('Início')).toHaveValue('08:00');
    expect(within(form).getByLabelText('Fim')).toHaveValue('12:00');
  });

  it('a exceção gravada aparece no dia e na hora da clínica', async () => {
    mockAvailability([VACATION]);
    renderWithQueryClient(<DisponibilidadePage />);

    await screen.findByRole('note');
    const section = screen.getByRole('region', { name: 'Exceções' });
    expect(section).toHaveTextContent(/11\/01\/2031,? 00:00 até 21\/01\/2031,? 00:00/);
  });

  it('a exceção digitada é lida como hora da clínica', async () => {
    const user = userEvent.setup();
    const api = mockAvailability([], {
      'PUT /therapists/:id/availability/exceptions': (request) => ({ body: { therapistId: 't1', windows: [MONDAY], exceptions: (request.body as { exceptions: unknown[] }).exceptions } }),
    });
    renderWithQueryClient(<DisponibilidadePage />);
    await screen.findByRole('note');
    const form = screen.getByRole('form', { name: 'Nova exceção' });

    // 09:00–12:00 de 11/03/2031 em Kiritimati = 19:00–22:00 UTC de 10/03/2031.
    fireEvent.change(within(form).getByLabelText('De'), { target: { value: '2031-03-11T09:00' } });
    fireEvent.change(within(form).getByLabelText('Até'), { target: { value: '2031-03-11T12:00' } });
    await user.click(within(form).getByRole('button', { name: 'Adicionar exceção' }));

    await waitFor(() => expect(api.sent('PUT', '/therapists/:id/availability/exceptions')).toHaveLength(1));
    expect(api.sent('PUT', '/therapists/:id/availability/exceptions')[0].body).toEqual({
      exceptions: [{ from: '2031-03-10T19:00:00.000Z', to: '2031-03-10T22:00:00.000Z' }],
    });
  });

  it('acrescentar uma exceção não desloca as que já estavam gravadas', async () => {
    const user = userEvent.setup();
    const api = mockAvailability([VACATION], {
      'PUT /therapists/:id/availability/exceptions': (request) => ({ body: { therapistId: 't1', windows: [MONDAY], exceptions: (request.body as { exceptions: unknown[] }).exceptions } }),
    });
    renderWithQueryClient(<DisponibilidadePage />);
    await screen.findByRole('note');
    const form = screen.getByRole('form', { name: 'Nova exceção' });

    fireEvent.change(within(form).getByLabelText('De'), { target: { value: '2031-03-11T09:00' } });
    fireEvent.change(within(form).getByLabelText('Até'), { target: { value: '2031-03-11T12:00' } });
    await user.click(within(form).getByRole('button', { name: 'Adicionar exceção' }));

    await waitFor(() => expect(api.sent('PUT', '/therapists/:id/availability/exceptions')).toHaveLength(1));
    expect(api.sent('PUT', '/therapists/:id/availability/exceptions')[0].body).toEqual({
      exceptions: [VACATION, { from: '2031-03-10T19:00:00.000Z', to: '2031-03-10T22:00:00.000Z' }],
    });
  });

  it('horário fixo: a primeira ocorrência digitada é hora da clínica', async () => {
    const user = userEvent.setup();
    const api = mockAvailability([], { 'POST /recurring-blocks': { status: 201, body: { id: 'b1' } } });
    renderWithQueryClient(<DisponibilidadePage />);
    await screen.findByRole('note');
    const form = screen.getByRole('form', { name: 'Novo horário fixo' });
    await waitFor(() => expect(within(form).getByRole('option', { name: 'Ana Souza' })).toBeInTheDocument());

    await user.selectOptions(within(form).getByLabelText('Paciente'), 'p1');
    // 09:00 de 03/02/2031 em Kiritimati = 19:00 UTC de 02/02/2031.
    fireEvent.change(within(form).getByLabelText('Primeira ocorrência'), { target: { value: '2031-02-03T09:00' } });
    await user.click(within(form).getByRole('button', { name: 'Criar horário fixo' }));

    await waitFor(() => expect(api.sent('POST', '/recurring-blocks')).toHaveLength(1));
    expect(api.sent('POST', '/recurring-blocks')[0].body).toMatchObject({ firstOccurrence: '2031-02-02T19:00:00.000Z' });
  });

  it('a prévia dos próximos 7 dias começa à meia-noite da clínica e conta cada horário no dia de lá', async () => {
    // Dois horários daqui a dois dias: o mesmo dia em Kiritimati (09:00 e 10:00 de lá).
    const base = new Date(new Date(`${wallClockInKiritimati(new Date().toISOString()).day}T00:00:00.000Z`).getTime() + 2 * 24 * HOUR - 14 * HOUR);
    const slot = (hour: number) => {
      const start = new Date(base.getTime() + hour * HOUR);
      return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 50 * 60_000).toISOString() };
    };
    const api = mockAvailability([], { 'GET /therapists/:id/availability': { body: { data: [slot(9), slot(10)] } } });
    renderWithQueryClient(<DisponibilidadePage />);
    await screen.findByRole('note');

    await waitFor(() => {
      const calls = api.sent('GET', '/therapists/:id/availability');
      expect(wallClockInKiritimati(calls[calls.length - 1].query.get('from')).time).toBe('00:00:00');
    });
    const calls = api.sent('GET', '/therapists/:id/availability');
    const { query } = calls[calls.length - 1];
    expect(wallClockInKiritimati(query.get('from')).day).toBe(wallClockInKiritimati(new Date().toISOString()).day);
    expect(new Date(query.get('to') as string).getTime() - new Date(query.get('from') as string).getTime()).toBe(7 * 24 * HOUR);

    const preview = screen.getByRole('region', { name: 'Horários livres' });
    await waitFor(() => expect(within(preview).getAllByRole('listitem')).toHaveLength(1));
    const [dayOfMonth, month] = [wallClockInKiritimati(slot(9).startsAt).day.slice(8, 10), wallClockInKiritimati(slot(9).startsAt).day.slice(5, 7)];
    expect(within(preview).getByRole('listitem')).toHaveTextContent(new RegExp(`${dayOfMonth}/${month}.*2 horários`));
  });
});

describe('Financeiro e Notificações — datas com hora aparecem na hora da clínica', () => {
  it('Financeiro: a sessão a cobrar aparece com a data e a hora da consulta na clínica; o vencimento, que é uma data sem hora, não muda', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /clinic': { body: clinicIn(KIRITIMATI) },
      'GET /billings': { body: { data: [{ id: 'billing-1', patientId: 'patient-1', amount: 200, dueDate: '2026-08-10T00:00:00.000Z', state: 'Criada' }] } },
      'GET /patients': { body: { data: [{ id: 'patient-1', name: 'Paciente Teste', phone: '+5541900000000', state: 'Ativo', billingPolicyOverride: null }] } },
      'GET /therapists': { body: { data: [{ id: 't1', name: 'Dra. Marta', specialty: null }] } },
      // 12:00 UTC de 10/03/2031 é 02:00 de 11/03/2031 em Kiritimati.
      'GET /sessions': { body: { data: [{ id: 'session-1', appointmentId: 'a1', patientId: 'patient-1', therapistId: 't1', state: 'Realizada', scheduledAt: '2031-03-10T12:00:00.000Z' }] } },
      'GET /billings/:id/payments': { body: { data: [] } },
      'GET /notifications/unread-count': { body: { count: 0 } },
    });
    renderWithQueryClient(<FinanceiroPage />);

    // O vencimento é 10/08 em qualquer fuso (em Kiritimati, a meia-noite UTC do dia 10 já seria 14:00 do dia 10; em São Paulo, 21:00 do dia 9).
    expect(await screen.findByText(/Vencimento: 10\/08\/2026/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Nova cobrança' }));
    const form = screen.getByRole('form', { name: 'Nova cobrança' });
    await waitFor(() => expect(within(form).getByRole('option', { name: 'Paciente Teste' })).toBeInTheDocument());
    await user.selectOptions(within(form).getByLabelText('Paciente'), 'patient-1');

    const session = (await within(form).findByRole('checkbox')).closest('label') as HTMLElement;
    expect(session).toHaveTextContent(/11\/03\/2031,? 02:00/);
  });

  it('Notificações: a hora do aviso é a da clínica', async () => {
    mockApi({
      'GET /clinic': { body: clinicIn(KIRITIMATI) },
      'GET /notifications': {
        body: {
          data: [{ id: 'n1', type: 'payment_divergent', title: 'Pagamento divergente', message: 'Confira o valor.', entityType: null, entityId: null, readAt: null, createdAt: '2031-03-10T12:00:00.000Z' }],
          next_cursor: null,
        },
      },
      'GET /notifications/unread-count': { body: { count: 1 } },
    });
    renderWithQueryClient(<NotificacoesPage />);

    const item = (await screen.findByText('Pagamento divergente')).closest('li') as HTMLElement;
    await waitFor(() => expect(item).toHaveTextContent(/11\/03\/2031,? 02:00:00/));
  });
});
