import { describe, it, expect, vi, afterEach } from 'vitest';
import { AvailabilityCalendar } from '@domain/availability/availability-calendar.entity';
import { Billing } from '@domain/billing/billing.entity';
import { Therapist } from '@domain/therapist/therapist.entity';
import { TenantContext } from '@shared/tenant-context';
import { IntentActionRouter } from '@use-cases/ai/intent-action-router';
import { DefinirDisponibilidadeUseCase, DefinirExcecoesDisponibilidadeUseCase } from '@use-cases/availability/gerenciar-disponibilidade.use-case';
import { ConsultarSegmentacaoFinanceiraUseCase } from '@use-cases/billing/consultar-segmentacao-financeira.use-case';
import { GerarFechamentoMensalUseCase } from '@use-cases/billing/gerar-fechamento-mensal.use-case';
import { buildAgendaSummaryMessage, tomorrowAt } from '@use-cases/communication/templates/agenda-summary.template';
import { ObterResumoDashboardUseCase } from '@use-cases/dashboard/obter-resumo-dashboard.use-case';
import { EnviarResumoAgendaDoDiaUseCase } from '@use-cases/scheduling/enviar-resumo-agenda-do-dia.use-case';
import { ReenviarAgendaAtualizadaUseCase } from '@use-cases/scheduling/reenviar-agenda-atualizada.use-case';

/**
 * AD-039 (ADR-0064) — os Casos de Uso perguntam o fuso à clínica e o usam.
 *
 * Cada teste roda com a clínica em um fuso escolhido e confere o resultado
 * em instantes escritos em UTC. Onde o "agora" importa, o relógio é fixado.
 */
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const clinicIn = (timeZone: string) => ({ current: vi.fn().mockResolvedValue(timeZone) });

afterEach(() => {
  vi.useRealTimers();
});

describe('"amanhã" e os horários do resumo de agenda são os da clínica', () => {
  // 22:30 de segunda, 12/10/2026, em São Paulo — em UTC já é terça, 13/10, 01:30.
  const LATE_EVENING = new Date('2026-10-13T01:30:00Z');

  it('tomorrowAt: às 22:30 de segunda em São Paulo, amanhã é terça — não quarta, como seria pelo relógio UTC', () => {
    const tomorrow = tomorrowAt('America/Sao_Paulo', LATE_EVENING);

    expect(tomorrow.date).toEqual({ year: 2026, month: 10, day: 13 });
    expect(tomorrow.from.toISOString()).toBe('2026-10-13T03:00:00.000Z');
    expect(tomorrow.to.toISOString()).toBe('2026-10-14T02:59:59.999Z');
  });

  it('tomorrowAt: no mesmo instante, cada clínica tem o seu amanhã', () => {
    expect(tomorrowAt('Asia/Tokyo', LATE_EVENING).date).toEqual({ year: 2026, month: 10, day: 14 });
    expect(tomorrowAt('America/Rio_Branco', LATE_EVENING).date).toEqual({ year: 2026, month: 10, day: 13 });
    expect(tomorrowAt('America/Rio_Branco', LATE_EVENING).from.toISOString()).toBe('2026-10-13T05:00:00.000Z');
  });

  it('buildAgendaSummaryMessage escreve a hora de parede da clínica', () => {
    const appointments = [
      { scheduledAt: new Date('2026-10-13T17:30:00Z'), state: 'Agendada' },
      { scheduledAt: new Date('2026-10-13T12:00:00Z'), state: 'Confirmada' },
    ];

    const saoPaulo = buildAgendaSummaryMessage('Ana Souza', appointments, 'America/Sao_Paulo');
    expect(saoPaulo).toContain('09:00 — paciente (confirmado)');
    expect(saoPaulo).toContain('14:30 — paciente (aguardando confirmação)');
    expect(saoPaulo.indexOf('09:00')).toBeLessThan(saoPaulo.indexOf('14:30'));
    expect(saoPaulo).not.toContain('12:00');

    expect(buildAgendaSummaryMessage('Ana Souza', appointments, 'America/Manaus')).toContain('08:00 — paciente (confirmado)');
    expect(buildAgendaSummaryMessage('Ana Souza', [], 'America/Sao_Paulo', true)).toContain('foi atualizada');
  });

  function agendaDependencies() {
    const therapist = Therapist.create({ id: 't1', tenantId: TENANT_ID, name: 'Dra. Ana' });
    const appointmentRepo = { findActiveByTherapistAndRange: vi.fn().mockResolvedValue([{ scheduledAt: new Date('2026-10-13T12:00:00Z'), state: 'Confirmada' }]) };
    const therapistRepo = { findById: vi.fn().mockResolvedValue(therapist) };
    const messageQueue = { enqueue: vi.fn().mockResolvedValue(undefined) };
    return { appointmentRepo, therapistRepo, messageQueue };
  }

  it('EnviarResumoAgendaDoDia busca o dia de amanhã da clínica e põe essa data na chave de idempotência', async () => {
    vi.useFakeTimers({ now: LATE_EVENING });
    const { appointmentRepo, therapistRepo, messageQueue } = agendaDependencies();
    const useCase = new EnviarResumoAgendaDoDiaUseCase(appointmentRepo as never, therapistRepo as never, messageQueue as never, clinicIn('America/Sao_Paulo'));

    await useCase.execute(TENANT_ID, 't1', '+5541900000000');

    expect(appointmentRepo.findActiveByTherapistAndRange).toHaveBeenCalledWith('t1', new Date('2026-10-13T03:00:00.000Z'), new Date('2026-10-14T02:59:59.999Z'));
    const message = messageQueue.enqueue.mock.calls[0][0];
    expect(message.idempotencyKey).toBe('agenda-summary-t1-2026-10-13');
    expect(message.body).toContain('09:00 — paciente (confirmado)');
  });

  it('EnviarResumoAgendaDoDia: em uma clínica de Tóquio, no mesmo instante, o dia buscado é outro', async () => {
    vi.useFakeTimers({ now: LATE_EVENING });
    const { appointmentRepo, therapistRepo, messageQueue } = agendaDependencies();
    const useCase = new EnviarResumoAgendaDoDiaUseCase(appointmentRepo as never, therapistRepo as never, messageQueue as never, clinicIn('Asia/Tokyo'));

    await useCase.execute(TENANT_ID, 't1', '+5541900000000');

    expect(appointmentRepo.findActiveByTherapistAndRange).toHaveBeenCalledWith('t1', new Date('2026-10-13T15:00:00.000Z'), new Date('2026-10-14T14:59:59.999Z'));
    expect(messageQueue.enqueue.mock.calls[0][0].idempotencyKey).toBe('agenda-summary-t1-2026-10-14');
  });

  it('ReenviarAgendaAtualizada usa o mesmo dia e a mesma hora de parede', async () => {
    vi.useFakeTimers({ now: LATE_EVENING });
    const { appointmentRepo, therapistRepo, messageQueue } = agendaDependencies();
    const useCase = new ReenviarAgendaAtualizadaUseCase(appointmentRepo as never, therapistRepo as never, messageQueue as never, clinicIn('America/Sao_Paulo'));

    await useCase.execute(TENANT_ID, 't1', '+5541900000000');

    expect(appointmentRepo.findActiveByTherapistAndRange).toHaveBeenCalledWith('t1', new Date('2026-10-13T03:00:00.000Z'), new Date('2026-10-14T02:59:59.999Z'));
    expect(messageQueue.enqueue.mock.calls[0][0].body).toContain('09:00 — paciente (confirmado)');
  });
});

describe('o que a secretária escreve ao paciente está na hora da clínica', () => {
  function routerIn(timeZone: string) {
    const agendarConsulta = { execute: vi.fn().mockResolvedValue({ scheduledAt: new Date('2026-08-03T12:00:00Z') }) };
    // K2-b — a remarcação devolve a ocorrência anterior e a nova (o horário anunciado é o da nova).
    const remarcarConsulta = {
      execute: vi.fn().mockResolvedValue({ previous: { scheduledAt: new Date('2026-08-03T12:00:00Z') }, current: { scheduledAt: new Date('2026-08-04T17:30:00Z') } }),
    };
    const consultarDisponibilidade = {
      execute: vi.fn().mockResolvedValue([
        { startsAt: new Date('2026-08-03T12:00:00Z'), endsAt: new Date('2026-08-03T13:00:00Z') },
        { startsAt: new Date('2026-08-03T13:00:00Z'), endsAt: new Date('2026-08-03T14:00:00Z') },
      ]),
    };
    const unused = { execute: vi.fn() };
    return new IntentActionRouter(
      agendarConsulta as never,
      unused as never,
      unused as never,
      unused as never,
      remarcarConsulta as never,
      consultarDisponibilidade as never,
      clinicIn(timeZone),
    );
  }
  const context = { tenantId: TENANT_ID, patientId: 'p1' };
  const intent = (name: string, entities: Record<string, unknown>) => ({ intent: name, confidence: 0.9, entities, requiresEscalation: false }) as never;

  it('consulta marcada para as 09:00 de São Paulo é anunciada como 09:00 — não 12:00, a hora UTC', async () => {
    const result = await routerIn('America/Sao_Paulo').route(intent('agendar_consulta', { therapistId: 't1', scheduledAt: '2026-08-03T12:00:00Z' }), context);

    expect(result.actionSummary).toBe('Consulta agendada para 03/08/2026, 09:00:00.');
  });

  it('a mesma consulta, em uma clínica de Manaus, é anunciada como 08:00', async () => {
    const result = await routerIn('America/Manaus').route(intent('agendar_consulta', { therapistId: 't1', scheduledAt: '2026-08-03T12:00:00Z' }), context);

    expect(result.actionSummary).toBe('Consulta agendada para 03/08/2026, 08:00:00.');
  });

  it('remarcação e horários livres seguem a mesma regra', async () => {
    const router = routerIn('America/Sao_Paulo');

    const rescheduled = await router.route(intent('remarcar_consulta', { appointmentId: 'a1', newScheduledAt: '2026-08-04T17:30:00Z' }), context);
    expect(rescheduled.actionSummary).toBe('Consulta reagendada para 04/08/2026, 14:30:00.');

    const available = await router.route(intent('consultar_disponibilidade', { therapistId: 't1' }), context);
    expect(available.actionSummary).toBe('Horários disponíveis: 03/08/2026, 09:00:00, 03/08/2026, 10:00:00.');
  });

  it('o dia anunciado também é o da clínica: 22:00 de domingo em São Paulo, já segunda em UTC', async () => {
    const agendar = { execute: vi.fn().mockResolvedValue({ scheduledAt: new Date('2026-08-03T01:00:00Z') }) };
    const unused = { execute: vi.fn() };
    const router = new IntentActionRouter(agendar as never, unused as never, unused as never, unused as never, unused as never, unused as never, clinicIn('America/Sao_Paulo'));

    const result = await router.route(intent('agendar_consulta', { therapistId: 't1', scheduledAt: '2026-08-03T01:00:00Z' }), context);

    expect(result.actionSummary).toBe('Consulta agendada para 02/08/2026, 22:00:00.');
  });
});

describe('o calendário de disponibilidade nasce com o fuso da clínica', () => {
  function tenantContext() {
    const context = new TenantContext();
    context.set(TENANT_ID, 'user-1');
    return context;
  }
  const therapistRepo = () => ({ findById: vi.fn().mockResolvedValue(Therapist.create({ id: 't1', tenantId: TENANT_ID, name: 'Dra. Ana' })) });
  const audit = { recordAll: vi.fn().mockResolvedValue(undefined) };

  it('DefinirDisponibilidade: o primeiro calendário de um terapeuta recebe o fuso lido da clínica', async () => {
    const availabilityRepo = { findByTherapistId: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue(undefined) };
    const clinic = clinicIn('America/Manaus');
    const useCase = new DefinirDisponibilidadeUseCase(availabilityRepo, therapistRepo() as never, tenantContext(), audit as never, clinic);

    const calendar = await useCase.execute('t1', [{ dayOfWeek: 1, startTime: '09:00', endTime: '10:00', sessionDurationMinutes: 60 }]);

    expect(calendar.timeZone).toBe('America/Manaus');
    expect(calendar.isAvailable(new Date('2026-08-03T13:00:00Z'), new Date('2026-08-03T14:00:00Z'), [])).toBe(true); // 09:00 em Manaus
    expect(clinic.current).toHaveBeenCalledTimes(1);
  });

  it('DefinirExcecoes: idem', async () => {
    const availabilityRepo = { findByTherapistId: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue(undefined) };
    const useCase = new DefinirExcecoesDisponibilidadeUseCase(availabilityRepo, therapistRepo() as never, tenantContext(), audit as never, clinicIn('Asia/Tokyo'));

    const calendar = await useCase.execute('t1', [{ from: new Date('2026-08-03T00:00:00Z'), to: new Date('2026-08-04T00:00:00Z') }]);

    expect(calendar.timeZone).toBe('Asia/Tokyo');
  });

  it('calendário que já existe mantém o fuso com que veio do repositório, sem nova consulta', async () => {
    const existing = AvailabilityCalendar.create({ id: 'cal1', tenantId: TENANT_ID, therapistId: 't1', timeZone: 'America/Sao_Paulo' });
    const availabilityRepo = { findByTherapistId: vi.fn().mockResolvedValue(existing), save: vi.fn().mockResolvedValue(undefined) };
    const clinic = clinicIn('Asia/Tokyo');
    const useCase = new DefinirDisponibilidadeUseCase(availabilityRepo, therapistRepo() as never, tenantContext(), audit as never, clinic);

    const calendar = await useCase.execute('t1', [{ dayOfWeek: 1, startTime: '09:00', endTime: '10:00', sessionDurationMinutes: 60 }]);

    expect(calendar.timeZone).toBe('America/Sao_Paulo');
    expect(clinic.current).not.toHaveBeenCalled();
  });
});

describe('atraso de cobrança: contado pelo dia da clínica', () => {
  // Vence em 10/08/2026. 23:30 desse dia em São Paulo é 02:30Z do dia 11; 00:30 do dia 11 é 03:30Z.
  const DUE = new Date('2026-08-10T00:00:00Z');
  const STILL_DUE_DAY = new Date('2026-08-11T02:30:00Z');
  const NEXT_DAY = new Date('2026-08-11T03:30:00Z');
  const billing = (state: 'Atrasada' | 'Pendente', dueDate = DUE) => Billing.reconstitute({ id: 'b1', tenantId: TENANT_ID, patientId: 'p1', amount: 400, dueDate, state });
  const billingRepo = (billings: Billing[]) => ({ findOverdueByTenant: vi.fn().mockResolvedValue(billings), findAllByTenant: vi.fn().mockResolvedValue(billings) });

  it('o resumo do painel passa o fuso da clínica para a contagem no banco', async () => {
    const patientRepository = { countActiveByTenant: vi.fn().mockResolvedValue(2) };
    const billingRepository = { countOverdueByTenant: vi.fn().mockResolvedValue(3), sumPendingByTenant: vi.fn().mockResolvedValue(900) };
    const useCase = new ObterResumoDashboardUseCase(patientRepository as never, billingRepository as never, clinicIn('America/Manaus'));

    expect(await useCase.execute()).toEqual({ activePatients: 2, overdueBillings: 3, totalPending: 900 });
    expect(billingRepository.countOverdueByTenant).toHaveBeenCalledWith('America/Manaus');
  });

  it('segmentação: às 23:30 do dia do vencimento ainda são 0 dias; à 00:30 do dia seguinte, 1 dia', async () => {
    const useCase = new ConsultarSegmentacaoFinanceiraUseCase(billingRepo([billing('Atrasada')]) as never, clinicIn('America/Sao_Paulo'));

    vi.useFakeTimers({ now: STILL_DUE_DAY });
    expect((await useCase.execute())[0].daysOverdue).toBe(0);

    vi.setSystemTime(NEXT_DAY);
    expect((await useCase.execute())[0].daysOverdue).toBe(1);
  });

  it('segmentação: no mesmo instante, o número de dias depende da clínica', async () => {
    vi.useFakeTimers({ now: NEXT_DAY });

    const saoPaulo = new ConsultarSegmentacaoFinanceiraUseCase(billingRepo([billing('Atrasada')]) as never, clinicIn('America/Sao_Paulo'));
    const manaus = new ConsultarSegmentacaoFinanceiraUseCase(billingRepo([billing('Atrasada')]) as never, clinicIn('America/Manaus'));

    expect((await saoPaulo.execute())[0].daysOverdue).toBe(1);
    expect((await manaus.execute())[0].daysOverdue).toBe(0); // 23:30 do dia 10 em Manaus
  });

  it('fechamento mensal: "pendente" no dia do vencimento, "em_atraso" a partir da meia-noite seguinte na clínica', async () => {
    const useCase = new GerarFechamentoMensalUseCase(billingRepo([billing('Pendente')]) as never, clinicIn('America/Sao_Paulo'));

    vi.useFakeTimers({ now: STILL_DUE_DAY });
    expect((await useCase.execute()).pendingByPatient[0].status).toBe('pendente');

    vi.setSystemTime(NEXT_DAY);
    expect((await useCase.execute()).pendingByPatient[0].status).toBe('em_atraso');
  });

  it('fechamento mensal: inadimplente só acima de 40 dias do calendário da clínica', async () => {
    const useCase = new GerarFechamentoMensalUseCase(billingRepo([billing('Pendente')]) as never, clinicIn('America/Sao_Paulo'));

    vi.useFakeTimers({ now: new Date('2026-09-20T02:59:59Z') }); // 19/09 23:59 em São Paulo: 40 dias
    expect((await useCase.execute()).pendingByPatient[0].status).toBe('em_atraso');

    vi.setSystemTime(new Date('2026-09-20T03:00:00Z')); // 20/09 00:00: 41 dias
    expect((await useCase.execute()).pendingByPatient[0].status).toBe('inadimplente');
  });
});
