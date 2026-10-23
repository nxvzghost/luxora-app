import { describe, it, expect, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AgendarConsultaUseCase } from '@use-cases/appointment/agendar-consulta.use-case';
import {
  RemarcarConsultaUseCase,
  CancelarConsultaUseCase,
  ConfirmarConsultaUseCase,
} from '@use-cases/appointment/gerenciar-consulta.use-case';
import { CriarAgendamentoRecorrenteUseCase } from '@use-cases/appointment/criar-agendamento-recorrente.use-case';
import { AppointmentOutcomeRecord } from '@domain/appointment/appointment-outcome';
import { AppointmentRepository } from '@domain-services/patient-ops/appointment.repository';
import { TenantContext } from '@shared/tenant-context';
import { SlotNotAvailableError } from '@domain-services/availability/slot-not-available.error';
import {
  AFTER_START,
  BEFORE_START,
  START,
  TENANT_ID,
  World,
  appointmentIn,
  createWorld,
  errorOf,
  legacySession,
  withAppointment,
} from './support/lifecycle-world';

function tenantContext() {
  const tc = new TenantContext();
  tc.set(TENANT_ID, 'user-1');
  return tc;
}

/** Repositório só com o que os casos de uso de criação chamam; o resto é stub. */
function repoMock(overrides: Partial<AppointmentRepository> = {}): AppointmentRepository {
  return {
    findById: vi.fn(),
    findByIdForUpdate: vi.fn(),
    findSuccessorId: vi.fn(),
    findActiveByTherapistAndRange: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    saveMany: vi.fn(),
    findByTenantAndRange: vi.fn(),
    existsForRecurringBlockOccurrence: vi.fn(),
    ...overrides,
  };
}

/** Motor de Disponibilidade fake — por padrão sempre disponível, salvo indicação em contrário. */
function motorDisponivel(disponivel = true) {
  return { execute: vi.fn().mockResolvedValue(disponivel) };
}

const audit = () => ({ recordAll: vi.fn().mockResolvedValue(undefined) }) as never;

function remarcar(world: World) {
  return new RemarcarConsultaUseCase(
    world.repo,
    world.outcomeRepo,
    world.noticeRepo,
    world.clinicRepo as never,
    world.motor as never,
    world.audit as never,
    world.unitOfWork,
    world.clock,
    world.tenantContext,
  );
}
function cancelar(world: World) {
  return new CancelarConsultaUseCase(
    world.repo,
    world.outcomeRepo,
    world.noticeRepo,
    world.clinicRepo as never,
    world.audit as never,
    world.unitOfWork,
    world.clock,
    world.tenantContext,
  );
}
function confirmar(world: World) {
  return new ConfirmarConsultaUseCase(world.repo, world.outcomeRepo, world.audit as never, world.unitOfWork, world.clock);
}

describe('AgendarConsultaUseCase', () => {
  it('cria o agendamento já no estado Reservada', async () => {
    const useCase = new AgendarConsultaUseCase(repoMock(), motorDisponivel() as never, audit(), tenantContext(), { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never);
    const appointment = await useCase.execute({ patientId: 'p1', therapistId: 't1', scheduledAt: new Date('2026-08-03T09:00:00'), modality: 'presencial' });
    expect(appointment.state).toBe('Reservada');
  });

  it('propaga SESSION_CONFLICT quando o Repository lança (índice único parcial do banco)', async () => {
    const repo = repoMock({ save: vi.fn().mockRejectedValue(new ConflictException({ code: 'SESSION_CONFLICT' })) });
    const useCase = new AgendarConsultaUseCase(repo, motorDisponivel() as never, audit(), tenantContext(), { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never);
    await expect(useCase.execute({ patientId: 'p1', therapistId: 't1', scheduledAt: new Date(), modality: 'presencial' })).rejects.toThrow(ConflictException);
  });

  it('recusa (SLOT_NOT_AVAILABLE) quando o Motor de Disponibilidade nega o horário — ADR-0040, sem sequer tentar salvar', async () => {
    const repo = repoMock();
    const useCase = new AgendarConsultaUseCase(repo, motorDisponivel(false) as never, audit(), tenantContext(), { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never);
    await expect(useCase.execute({ patientId: 'p1', therapistId: 't1', scheduledAt: new Date('2026-08-03T09:00:00'), modality: 'presencial' })).rejects.toThrow(SlotNotAvailableError);
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe('ConfirmarConsultaUseCase (T2) — confirmar não é realizar', () => {
  it('antes do início: só muda o estado de agenda; NÃO cria sessão nem nada no financeiro', async () => {
    const world = createWorld();
    withAppointment(world, appointmentIn('Reservada'));
    const appointment = await confirmar(world).execute('a1');
    expect(appointment.state).toBe('Confirmada');
    expect(world.sessionRepo.save).not.toHaveBeenCalled();
    expect(world.sessions.size).toBe(0);
    expect(world.outcomes.size).toBe(0);
    expect(world.audited.map((e) => e.eventName)).toEqual(['AgendamentoEstadoAlterado']);
  });

  it('no início ou depois: APPOINTMENT_ALREADY_STARTED, nada gravado', async () => {
    const world = createWorld();
    withAppointment(world, appointmentIn('Reservada'));
    world.now.value = START;
    expect(await errorOf(confirmar(world).execute('a1'))).toEqual({ status: 409, code: 'APPOINTMENT_ALREADY_STARTED' });
    expect(world.repo.save).not.toHaveBeenCalled();
  });

  it('consulta com desfecho: APPOINTMENT_OUTCOME_CONFLICT, o desfecho não é sobrescrito', async () => {
    const world = createWorld();
    const appointment = withAppointment(world, appointmentIn('Reservada'));
    world.outcomes.set('a1', AppointmentOutcomeRecord.recordNoShow(appointment, { userId: 'u1', now: AFTER_START }));
    expect(await errorOf(confirmar(world).execute('a1'))).toEqual({ status: 409, code: 'APPOINTMENT_OUTCOME_CONFLICT' });
  });

  it('transição inválida (já confirmada) responde 409 INVALID_STATE_TRANSITION', async () => {
    const world = createWorld();
    withAppointment(world, appointmentIn('Confirmada'));
    expect(await errorOf(confirmar(world).execute('a1'))).toEqual({ status: 409, code: 'INVALID_STATE_TRANSITION' });
  });
});

describe('CancelarConsultaUseCase (T3)', () => {
  it('pelo painel, antes do início: comunicação registrada com quem pediu, consulta Cancelada e desfecho que a congela', async () => {
    const world = createWorld({ cancellationHoursLimit: 24 });
    withAppointment(world, appointmentIn('Confirmada'));
    const result = await cancelar(world).execute('a1', { requestedBy: 'paciente', reason: 'viagem' });

    expect(result.changed).toBe(true);
    expect(result.appointment.state).toBe('Cancelada');
    expect(world.notices).toHaveLength(1);
    const [notice] = world.notices;
    expect([notice.channel, notice.intent, notice.requestedBy, notice.timing, notice.limitHoursApplied, notice.recordedByUserId]).toEqual([
      'painel',
      'pedido_cancelamento',
      'paciente',
      'no_prazo',
      24,
      'user-1',
    ]);
    const outcome = world.outcomes.get('a1');
    expect([outcome?.outcome, outcome?.stateAtOutcome, outcome?.closingNoticeId, outcome?.lateNoticeDecision]).toEqual(['Cancelada', 'Cancelada', notice.id, undefined]);
    expect(world.audited.map((e) => e.eventName)).toEqual(['ComunicacaoRegistrada', 'AgendamentoEstadoAlterado', 'ConsultaCancelada']);
    // O motivo fica na comunicação, nunca na auditoria.
    expect(JSON.stringify(world.audited)).not.toContain('viagem');
  });

  it('fora do prazo pedido pelo paciente: decisão de consequência aguardando (DP-22); pedido da clínica: nenhuma (DP-25)', async () => {
    for (const [requestedBy, expected] of [
      ['paciente', 'aguardando_decisao'],
      ['clinica', undefined],
      ['profissional', undefined],
    ] as const) {
      const world = createWorld({ cancellationHoursLimit: 72 });
      withAppointment(world, appointmentIn('Confirmada'));
      await cancelar(world).execute('a1', { requestedBy });
      expect([world.notices[0].timing, world.outcomes.get('a1')?.lateNoticeDecision]).toEqual(['fora_do_prazo', expected]);
    }
  });

  it('sem informar quem pediu: 400 REQUESTED_BY_REQUIRED, nada gravado', async () => {
    const world = createWorld();
    withAppointment(world, appointmentIn('Confirmada'));
    expect(await errorOf(cancelar(world).execute('a1', {}))).toEqual({ status: 400, code: 'REQUESTED_BY_REQUIRED' });
    expect(world.repo.save).not.toHaveBeenCalled();
    expect(world.notices).toHaveLength(0);
  });

  it('no início ou depois: APPOINTMENT_ALREADY_STARTED — depois do início é realização ou falta', async () => {
    const world = createWorld();
    withAppointment(world, appointmentIn('Confirmada'));
    world.now.value = START;
    expect(await errorOf(cancelar(world).execute('a1', { requestedBy: 'paciente' }))).toEqual({ status: 409, code: 'APPOINTMENT_ALREADY_STARTED' });
    expect(world.notices).toHaveLength(0);
    expect(world.repo.save).not.toHaveBeenCalled();
  });

  it('repetir o cancelamento não muda nada nem gera evento novo', async () => {
    const world = createWorld();
    withAppointment(world, appointmentIn('Confirmada'));
    await cancelar(world).execute('a1', { requestedBy: 'paciente' });
    world.audited.length = 0;
    const again = await cancelar(world).execute('a1', { requestedBy: 'paciente' });
    expect(again.changed).toBe(false);
    expect(world.audited).toHaveLength(0);
    expect(world.notices).toHaveLength(1);
  });

  it.each([
    ['Falta', 'APPOINTMENT_OUTCOME_CONFLICT'],
    ['Realizada', 'APPOINTMENT_OUTCOME_CONFLICT'],
  ] as const)('consulta com desfecho %s: %s', async (kind, code) => {
    const world = createWorld();
    const appointment = withAppointment(world, appointmentIn('Confirmada'));
    world.outcomes.set(
      'a1',
      kind === 'Falta'
        ? AppointmentOutcomeRecord.recordNoShow(appointment, { userId: 'u1', now: AFTER_START })
        : AppointmentOutcomeRecord.recordAttendance(appointment, { userId: 'u1', now: AFTER_START }),
    );
    expect(await errorOf(cancelar(world).execute('a1', { requestedBy: 'paciente' }))).toEqual({ status: 409, code });
  });

  it('pela IA (actor ai_agent): cancela antes do início, sem comunicação nem desfecho (K11 é da fase 5)', async () => {
    const world = createWorld({ userId: null });
    withAppointment(world, appointmentIn('Confirmada'));
    const result = await cancelar(world).execute('a1', {}, { expectedPatientId: 'p1', actor: 'ai_agent' });
    expect(result.appointment.state).toBe('Cancelada');
    expect(world.notices).toHaveLength(0);
    expect(world.outcomes.size).toBe(0);
  });

  it('pela IA, depois do início: recusado (DP-26)', async () => {
    const world = createWorld({ userId: null });
    withAppointment(world, appointmentIn('Confirmada'));
    world.now.value = AFTER_START;
    expect(await errorOf(cancelar(world).execute('a1', {}, { expectedPatientId: 'p1', actor: 'ai_agent' }))).toEqual({
      status: 409,
      code: 'APPOINTMENT_ALREADY_STARTED',
    });
  });

  it('pelo painel sem usuário (chave de API): 403 HUMAN_ACTOR_REQUIRED', async () => {
    const world = createWorld({ userId: null });
    withAppointment(world, appointmentIn('Confirmada'));
    expect(await errorOf(cancelar(world).execute('a1', { requestedBy: 'paciente' }))).toEqual({ status: 403, code: 'HUMAN_ACTOR_REQUIRED' });
  });
});

describe('RemarcarConsultaUseCase (T5) — nova ocorrência ligada, histórico preservado', () => {
  const NEW_TIME = new Date('2026-08-10T09:00:00.000Z');

  it('encerra a anterior como Remarcada (Cancelada na agenda) e cria a nova Reservada, ligada a ela', async () => {
    const world = createWorld();
    const previous = withAppointment(world, appointmentIn('Confirmada'));
    const result = await remarcar(world).execute('a1', NEW_TIME, { requestedBy: 'paciente' });

    expect(result.previous.id).toBe('a1');
    expect(result.previous.state).toBe('Cancelada');
    expect(result.previous.scheduledAt).toEqual(START); // o horário original fica na ocorrência anterior
    expect(result.current.id).not.toBe('a1');
    expect([result.current.state, result.current.scheduledAt, result.current.rescheduledFromId]).toEqual(['Reservada', NEW_TIME, 'a1']);
    expect(previous.state).toBe('Cancelada');
    const outcome = world.outcomes.get('a1');
    expect([outcome?.outcome, outcome?.stateAtOutcome, outcome?.scheduledAtAtOutcome, outcome?.closingNoticeId]).toEqual([
      'Remarcada',
      'Cancelada',
      START,
      world.notices[0].id,
    ]);
    expect(world.notices[0].intent).toBe('pedido_remarcacao');
    expect(world.appointments.get(result.current.id)).toBe(result.current);
    expect(world.audited.map((e) => e.eventName)).toEqual([
      'ComunicacaoRegistrada',
      'AgendamentoEstadoAlterado',
      'ConsultaRemarcada',
      'AgendamentoEstadoAlterado',
      'ConsultaRemarcada',
    ]);
  });

  it('a ordem é a do banco: a anterior é cancelada ANTES do desfecho, e a nova depois dele', async () => {
    const world = createWorld();
    withAppointment(world, appointmentIn('Confirmada'));
    const order: string[] = [];
    vi.mocked(world.repo.save).mockImplementation(async (appointment) => {
      order.push(`save:${appointment.id === 'a1' ? 'anterior' : 'nova'}:${appointment.state}`);
      world.appointments.set(appointment.id, appointment);
    });
    vi.mocked(world.outcomeRepo.insert).mockImplementation(async (record) => {
      order.push(`desfecho:${record.stateAtOutcome}`);
      world.outcomes.set(record.appointmentId, record);
    });
    await remarcar(world).execute('a1', NEW_TIME, { requestedBy: 'clinica' });
    expect(order).toEqual(['save:anterior:Cancelada', 'desfecho:Cancelada', 'save:nova:Reservada']);
  });

  it('consulta o Motor para o horário novo, excluindo a própria ocorrência; indisponível: nada gravado', async () => {
    const world = createWorld({ available: false });
    withAppointment(world, appointmentIn('Confirmada'));
    await expect(remarcar(world).execute('a1', NEW_TIME, { requestedBy: 'paciente' })).rejects.toThrow(SlotNotAvailableError);
    expect(world.motor.execute).toHaveBeenCalledWith(expect.objectContaining({ excludeAppointmentId: 'a1', scheduledAt: NEW_TIME }));
    expect(world.repo.save).not.toHaveBeenCalled();
    expect(world.notices).toHaveLength(0);
  });

  it('não existe: NotFoundException', async () => {
    const world = createWorld();
    await expect(remarcar(world).execute('a-inexistente', NEW_TIME, { requestedBy: 'paciente' })).rejects.toThrow(NotFoundException);
  });

  it('no início ou depois: APPOINTMENT_ALREADY_STARTED, o Motor nem é consultado', async () => {
    const world = createWorld();
    withAppointment(world, appointmentIn('Confirmada'));
    world.now.value = START;
    expect(await errorOf(remarcar(world).execute('a1', NEW_TIME, { requestedBy: 'paciente' }))).toEqual({ status: 409, code: 'APPOINTMENT_ALREADY_STARTED' });
    expect(world.motor.execute).not.toHaveBeenCalled();
  });

  it('remarcar de novo a ocorrência já remarcada: APPOINTMENT_ALREADY_RESCHEDULED (use a nova)', async () => {
    const world = createWorld();
    withAppointment(world, appointmentIn('Confirmada'));
    const { current } = await remarcar(world).execute('a1', NEW_TIME, { requestedBy: 'paciente' });
    expect(await errorOf(remarcar(world).execute('a1', new Date('2026-08-11T09:00:00Z'), { requestedBy: 'paciente' }))).toEqual({
      status: 409,
      code: 'APPOINTMENT_ALREADY_RESCHEDULED',
    });
    expect(await errorOf(cancelar(world).execute('a1', { requestedBy: 'paciente' }))).toEqual({ status: 409, code: 'APPOINTMENT_ALREADY_RESCHEDULED' });
    // A nova segue a vida normal.
    const again = await remarcar(world).execute(current.id, new Date('2026-08-12T09:00:00Z'), { requestedBy: 'paciente' });
    expect(again.current.rescheduledFromId).toBe(current.id);
  });

  it('pela IA: nova ocorrência ligada, sem comunicação nem desfecho; remarcar de novo a anterior é recusado', async () => {
    const world = createWorld({ userId: null });
    withAppointment(world, appointmentIn('Reservada'));
    const { current, outcome } = await remarcar(world).execute('a1', NEW_TIME, {}, { expectedPatientId: 'p1', actor: 'ai_agent' });
    expect(outcome).toBeNull();
    expect(current.rescheduledFromId).toBe('a1');
    expect(world.notices).toHaveLength(0);
    expect(await errorOf(remarcar(world).execute('a1', NEW_TIME, {}, { expectedPatientId: 'p1', actor: 'ai_agent' }))).toEqual({
      status: 409,
      code: 'APPOINTMENT_ALREADY_RESCHEDULED',
    });
  });

  it('a sessão legada da ocorrência anterior continua lá e inelegível (nenhum desfecho é inventado)', async () => {
    const world = createWorld();
    withAppointment(world, appointmentIn('Confirmada'));
    const session = legacySession();
    world.sessions.set(session.id, session);
    await remarcar(world).execute('a1', NEW_TIME, { requestedBy: 'paciente' });
    expect([session.billingEligibility, session.kind, session.isBillable]).toEqual(['nao_elegivel', undefined, false]);
    expect(world.sessionRepo.save).not.toHaveBeenCalled();
  });
});

describe('CriarAgendamentoRecorrenteUseCase', () => {
  it('cria N ocorrências espaçadas por intervalDays', async () => {
    const useCase = new CriarAgendamentoRecorrenteUseCase(repoMock(), motorDisponivel() as never, tenantContext(), audit(), { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never);
    const appointments = await useCase.execute({
      patientId: 'p1',
      therapistId: 't1',
      firstScheduledAt: new Date('2026-08-03T09:00:00'),
      modality: 'presencial',
      occurrences: 3,
      intervalDays: 7,
    });
    expect(appointments).toHaveLength(3);
    expect(appointments[1].scheduledAt.getDate()).toBe(10); // +7 dias
    expect(appointments[2].scheduledAt.getDate()).toBe(17); // +14 dias
  });

  it('rejeita occurrences menor que 1', async () => {
    const useCase = new CriarAgendamentoRecorrenteUseCase(repoMock(), motorDisponivel() as never, tenantContext(), audit(), { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never);
    await expect(
      useCase.execute({ patientId: 'p1', therapistId: 't1', firstScheduledAt: new Date(), modality: 'presencial', occurrences: 0, intervalDays: 7 }),
    ).rejects.toThrow(/ao menos 1/);
  });

  it('interrompe o lote se uma ocorrência colidir (SESSION_CONFLICT) — limitação documentada, sem rollback automático', async () => {
    const repo = repoMock({
      save: vi
        .fn()
        .mockResolvedValueOnce(undefined) // 1ª ocorrência: ok
        .mockRejectedValueOnce(new ConflictException({ code: 'SESSION_CONFLICT' })), // 2ª: colide
    });
    const useCase = new CriarAgendamentoRecorrenteUseCase(repo, motorDisponivel() as never, tenantContext(), audit(), { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never);
    await expect(
      useCase.execute({ patientId: 'p1', therapistId: 't1', firstScheduledAt: new Date('2026-08-03T09:00:00'), modality: 'presencial', occurrences: 3, intervalDays: 7 }),
    ).rejects.toThrow(ConflictException);
    expect(repo.save).toHaveBeenCalledTimes(2); // 1ª foi salva, 2ª falhou, 3ª nunca tentou
  });

  it('recusa (SLOT_NOT_AVAILABLE) o lote inteiro quando qualquer ocorrência é negada pelo Motor — nenhuma é criada', async () => {
    const repo = repoMock();
    // Todas as N ocorrências são validadas ANTES de qualquer criação — a 2ª
    // falha, então nem a 1ª (que passaria) chega a ser salva.
    const verificarDisponibilidade = { execute: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) };
    const useCase = new CriarAgendamentoRecorrenteUseCase(repo, verificarDisponibilidade as never, tenantContext(), audit(), { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never);
    await expect(
      useCase.execute({ patientId: 'p1', therapistId: 't1', firstScheduledAt: new Date('2026-08-03T09:00:00'), modality: 'presencial', occurrences: 3, intervalDays: 7 }),
    ).rejects.toThrow(SlotNotAvailableError);
    expect(repo.save).not.toHaveBeenCalled(); // lote inteiro recusado, zero ocorrências criadas
    expect(verificarDisponibilidade.execute).toHaveBeenCalledTimes(2); // parou de validar assim que a 2ª recusou
  });
});

/**
 * Tarefa 06 da auditoria (AD-032) — o paciente tem de ser da própria
 * clínica. `findById` do repositório passa pela RLS: paciente de outra
 * clínica volta como inexistente.
 */
describe('Tarefa 06 — consulta só para paciente da própria clínica', () => {
  const scheduledAt = new Date('2031-03-10T14:00:00.000Z');

  function setup(patientFound: boolean) {
    const repo = repoMock({ saveMany: vi.fn().mockResolvedValue(undefined) });
    const motor = { execute: vi.fn().mockResolvedValue(true) };
    const auditService = { recordAll: vi.fn().mockResolvedValue(undefined) };
    const patientRepo = { findById: vi.fn().mockResolvedValue(patientFound ? { id: 'p1' } : null) };
    return { context: tenantContext(), repo, motor, audit: auditService, patientRepo };
  }

  it('AgendarConsultaUseCase: paciente não encontrado — 404, o Motor nem é consultado e nada é gravado', async () => {
    const { context, repo, motor, audit: auditService, patientRepo } = setup(false);
    const useCase = new AgendarConsultaUseCase(repo, motor as never, auditService as never, context, patientRepo as never);
    await expect(useCase.execute({ patientId: 'p-de-outra-clinica', therapistId: 't1', scheduledAt, modality: 'presencial' })).rejects.toMatchObject({ status: 404 });
    expect(patientRepo.findById).toHaveBeenCalledWith('p-de-outra-clinica');
    expect(motor.execute).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    expect(auditService.recordAll).not.toHaveBeenCalled();
  });

  it('AgendarConsultaUseCase: paciente da clínica — segue para o Motor e grava', async () => {
    const { context, repo, motor, audit: auditService, patientRepo } = setup(true);
    const useCase = new AgendarConsultaUseCase(repo, motor as never, auditService as never, context, patientRepo as never);
    const appointment = await useCase.execute({ patientId: 'p1', therapistId: 't1', scheduledAt, modality: 'presencial' });
    expect(appointment.state).toBe('Reservada');
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it('CriarAgendamentoRecorrenteUseCase: paciente não encontrado — 404 e nenhuma ocorrência é gravada', async () => {
    const { context, repo, motor, audit: auditService, patientRepo } = setup(false);
    const useCase = new CriarAgendamentoRecorrenteUseCase(repo, motor as never, context, auditService as never, patientRepo as never);
    await expect(
      useCase.execute({ patientId: 'p-de-outra-clinica', therapistId: 't1', firstScheduledAt: scheduledAt, modality: 'presencial', occurrences: 3, intervalDays: 7 }),
    ).rejects.toMatchObject({ status: 404 });
    expect(motor.execute).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.saveMany).not.toHaveBeenCalled();
  });
});

describe('Consulta de quem? — conferência de dono para quem age em nome de um paciente (ADR-0063, AD-038)', () => {
  const ai = (expectedPatientId: string) => ({ expectedPatientId, actor: 'ai_agent' as const });

  it('cancelar a consulta de OUTRO paciente responde "não encontrado" e não grava nada', async () => {
    const world = createWorld({ userId: null });
    const appointment = withAppointment(world, appointmentIn('Reservada'));
    await expect(cancelar(world).execute('a1', {}, ai('p-outro'))).rejects.toThrow(NotFoundException);
    expect(appointment.state).toBe('Reservada');
    expect(world.repo.save).not.toHaveBeenCalled();
  });

  it('confirmar a consulta de OUTRO paciente não confirma', async () => {
    const world = createWorld({ userId: null });
    const appointment = withAppointment(world, appointmentIn('Reservada'));
    await expect(confirmar(world).execute('a1', ai('p-outro'))).rejects.toThrow(NotFoundException);
    expect(appointment.state).toBe('Reservada');
    expect(world.repo.save).not.toHaveBeenCalled();
  });

  it('remarcar a consulta de OUTRO paciente não consulta o Motor nem muda nada', async () => {
    const world = createWorld({ userId: null });
    const appointment = withAppointment(world, appointmentIn('Reservada'));
    await expect(remarcar(world).execute('a1', new Date('2026-08-04T10:00:00Z'), {}, ai('p-outro'))).rejects.toThrow(NotFoundException);
    expect(world.motor.execute).not.toHaveBeenCalled();
    expect(world.repo.save).not.toHaveBeenCalled();
    expect(appointment.scheduledAt).toEqual(START);
  });

  it('a recusa é a mesma de uma consulta inexistente — não confirma a ninguém que o id existe', async () => {
    const existing = createWorld({ userId: null });
    withAppointment(existing, appointmentIn('Reservada'));
    const missing = createWorld({ userId: null });
    const wrongOwner = await cancelar(existing).execute('a1', {}, ai('p-outro')).catch((error: Error) => error.message);
    const notFound = await cancelar(missing).execute('a1', {}, ai('p1')).catch((error: Error) => error.message);
    expect(wrongOwner).toBe(notFound);
  });

  it('do próprio paciente: age normalmente', async () => {
    const world = createWorld({ userId: null });
    const appointment = withAppointment(world, appointmentIn('Reservada'));
    await cancelar(world).execute('a1', {}, ai('p1'));
    expect(appointment.state).toBe('Cancelada');
  });

  it('o horário de agora vem do relógio injetado (antes do início, por padrão nestes testes)', () => {
    expect(createWorld().clock.now()).toEqual(BEFORE_START);
  });
});
