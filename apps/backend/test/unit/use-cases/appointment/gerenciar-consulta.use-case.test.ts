import { describe, it, expect, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AgendarConsultaUseCase } from '@use-cases/appointment/agendar-consulta.use-case';
import {
  RemarcarConsultaUseCase,
  CancelarConsultaUseCase,
  ConfirmarConsultaUseCase,
} from '@use-cases/appointment/gerenciar-consulta.use-case';
import { CriarAgendamentoRecorrenteUseCase } from '@use-cases/appointment/criar-agendamento-recorrente.use-case';
import { Appointment, AppointmentState } from '@domain/appointment/appointment.entity';
import { AppointmentRepository } from '@domain-services/patient-ops/appointment.repository';
import { TenantContext } from '@shared/tenant-context';
import { SlotNotAvailableError } from '@domain-services/availability/slot-not-available.error';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function tenantContext() {
  const tc = new TenantContext();
  tc.set(TENANT_ID, 'user-1');
  return tc;
}

function fakeAppointment(state: AppointmentState) {
  return Appointment.reconstitute({
    id: 'a1',
    tenantId: TENANT_ID,
    patientId: 'p1',
    therapistId: 't1',
    scheduledAt: new Date('2026-08-03T09:00:00'),
    modality: 'presencial',
    state,
    recurring: false,
  });
}

/** Motor de Disponibilidade fake — por padrão sempre disponível, salvo indicação em contrário. */
function motorDisponivel(disponivel = true) {
  return { execute: vi.fn().mockResolvedValue(disponivel) };
}

describe('AgendarConsultaUseCase', () => {
  it('cria o agendamento já no estado Reservada', async () => {
    const repo: AppointmentRepository = { findById: vi.fn(), findActiveByTherapistAndRange: vi.fn(), save: vi.fn().mockResolvedValue(undefined), saveMany: vi.fn() };
    const useCase = new AgendarConsultaUseCase(repo, motorDisponivel() as never, { recordAll: vi.fn().mockResolvedValue(undefined) } as never, tenantContext(), { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never);
    const appointment = await useCase.execute({
      patientId: 'p1',
      therapistId: 't1',
      scheduledAt: new Date('2026-08-03T09:00:00'),
      modality: 'presencial',
    });
    expect(appointment.state).toBe('Reservada');
  });

  it('propaga SESSION_CONFLICT quando o Repository lança (índice único parcial do banco)', async () => {
    const repo: AppointmentRepository = {
      findById: vi.fn(),
      findActiveByTherapistAndRange: vi.fn(),
      save: vi.fn().mockRejectedValue(new ConflictException({ code: 'SESSION_CONFLICT' })),
      saveMany: vi.fn(),
    };
    const useCase = new AgendarConsultaUseCase(repo, motorDisponivel() as never, { recordAll: vi.fn().mockResolvedValue(undefined) } as never, tenantContext(), { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never);
    await expect(
      useCase.execute({ patientId: 'p1', therapistId: 't1', scheduledAt: new Date(), modality: 'presencial' }),
    ).rejects.toThrow(ConflictException);
  });

  it('recusa (SLOT_NOT_AVAILABLE) quando o Motor de Disponibilidade nega o horário — ADR-0040, sem sequer tentar salvar', async () => {
    const repo: AppointmentRepository = { findById: vi.fn(), findActiveByTherapistAndRange: vi.fn(), save: vi.fn(), saveMany: vi.fn() };
    const verificarDisponibilidade = motorDisponivel(false);
    const useCase = new AgendarConsultaUseCase(repo, verificarDisponibilidade as never, { recordAll: vi.fn().mockResolvedValue(undefined) } as never, tenantContext(), { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never);
    await expect(
      useCase.execute({ patientId: 'p1', therapistId: 't1', scheduledAt: new Date('2026-08-03T09:00:00'), modality: 'presencial' }),
    ).rejects.toThrow(SlotNotAvailableError);
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe('RemarcarConsultaUseCase', () => {
  it('orquestra as duas transições da entidade (ReagendamentoSolicitado → Reagendada) em uma única chamada', async () => {
    const repo: AppointmentRepository = {
      findById: vi.fn().mockResolvedValue(fakeAppointment('Confirmada')),
      findActiveByTherapistAndRange: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      saveMany: vi.fn(),
    };
    const useCase = new RemarcarConsultaUseCase(repo, motorDisponivel() as never, { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const appointment = await useCase.execute('a1', new Date('2026-08-10T09:00:00'));
    expect(appointment.state).toBe('Reagendada');
  });

  it('lança NotFoundException quando o agendamento não existe', async () => {
    const repo: AppointmentRepository = { findById: vi.fn().mockResolvedValue(null), findActiveByTherapistAndRange: vi.fn(), save: vi.fn(), saveMany: vi.fn() };
    const useCase = new RemarcarConsultaUseCase(repo, motorDisponivel() as never, { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    await expect(useCase.execute('a-inexistente', new Date())).rejects.toThrow(NotFoundException);
  });

  it('recusa (SLOT_NOT_AVAILABLE) quando o novo horário não está disponível no Motor', async () => {
    const repo: AppointmentRepository = {
      findById: vi.fn().mockResolvedValue(fakeAppointment('Confirmada')),
      findActiveByTherapistAndRange: vi.fn(),
      save: vi.fn(),
      saveMany: vi.fn(),
    };
    const verificarDisponibilidade = motorDisponivel(false);
    const useCase = new RemarcarConsultaUseCase(repo, verificarDisponibilidade as never, { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    await expect(useCase.execute('a1', new Date('2026-08-10T09:00:00'))).rejects.toThrow(SlotNotAvailableError);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('exclui o próprio agendamento da checagem de conflito (excludeAppointmentId)', async () => {
    const repo: AppointmentRepository = {
      findById: vi.fn().mockResolvedValue(fakeAppointment('Confirmada')),
      findActiveByTherapistAndRange: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      saveMany: vi.fn(),
    };
    const verificarDisponibilidade = motorDisponivel();
    const useCase = new RemarcarConsultaUseCase(repo, verificarDisponibilidade as never, { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    await useCase.execute('a1', new Date('2026-08-10T09:00:00'));
    expect(verificarDisponibilidade.execute).toHaveBeenCalledWith(
      expect.objectContaining({ excludeAppointmentId: 'a1' }),
    );
  });
});

describe('CancelarConsultaUseCase', () => {
  it('transiciona para Cancelada', async () => {
    const repo: AppointmentRepository = {
      findById: vi.fn().mockResolvedValue(fakeAppointment('Reservada')),
      findActiveByTherapistAndRange: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      saveMany: vi.fn(),
    };
    const useCase = new CancelarConsultaUseCase(repo, { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const appointment = await useCase.execute('a1');
    expect(appointment.state).toBe('Cancelada');
  });
});

describe('ConfirmarConsultaUseCase', () => {
  it('transiciona para Confirmada e cria a Sessão correspondente (Session.createFromConfirmedAppointment)', async () => {
    const repo: AppointmentRepository = {
      findById: vi.fn().mockResolvedValue(fakeAppointment('Reservada')),
      findActiveByTherapistAndRange: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      saveMany: vi.fn(),
    };
    const sessionRepo = { findById: vi.fn(), save: vi.fn().mockResolvedValue(undefined) };
    const useCase = new ConfirmarConsultaUseCase(repo, sessionRepo, { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const appointment = await useCase.execute('a1');
    expect(appointment.state).toBe('Confirmada');
    expect(sessionRepo.save).toHaveBeenCalledOnce();
    const savedSession = sessionRepo.save.mock.calls[0][0];
    expect(savedSession.appointmentId).toBe('a1');
    expect(savedSession.state).toBe('Realizada');
  });
});

describe('CriarAgendamentoRecorrenteUseCase', () => {
  it('cria N ocorrências espaçadas por intervalDays', async () => {
    const repo: AppointmentRepository = { findById: vi.fn(), findActiveByTherapistAndRange: vi.fn(), save: vi.fn().mockResolvedValue(undefined), saveMany: vi.fn() };
    const useCase = new CriarAgendamentoRecorrenteUseCase(repo, motorDisponivel() as never, tenantContext(), { recordAll: vi.fn().mockResolvedValue(undefined) } as never, { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never);
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
    const repo: AppointmentRepository = { findById: vi.fn(), findActiveByTherapistAndRange: vi.fn(), save: vi.fn(), saveMany: vi.fn() };
    const useCase = new CriarAgendamentoRecorrenteUseCase(repo, motorDisponivel() as never, tenantContext(), { recordAll: vi.fn().mockResolvedValue(undefined) } as never, { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never);
    await expect(
      useCase.execute({
        patientId: 'p1',
        therapistId: 't1',
        firstScheduledAt: new Date(),
        modality: 'presencial',
        occurrences: 0,
        intervalDays: 7,
      }),
    ).rejects.toThrow(/ao menos 1/);
  });

  it('interrompe o lote se uma ocorrência colidir (SESSION_CONFLICT) — limitação documentada, sem rollback automático', async () => {
    const repo: AppointmentRepository = {
      findById: vi.fn(),
      findActiveByTherapistAndRange: vi.fn(),
      save: vi
        .fn()
        .mockResolvedValueOnce(undefined) // 1ª ocorrência: ok
        .mockRejectedValueOnce(new ConflictException({ code: 'SESSION_CONFLICT' })), // 2ª: colide
      saveMany: vi.fn(),
    };
    const useCase = new CriarAgendamentoRecorrenteUseCase(repo, motorDisponivel() as never, tenantContext(), { recordAll: vi.fn().mockResolvedValue(undefined) } as never, { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never);
    await expect(
      useCase.execute({
        patientId: 'p1',
        therapistId: 't1',
        firstScheduledAt: new Date('2026-08-03T09:00:00'),
        modality: 'presencial',
        occurrences: 3,
        intervalDays: 7,
      }),
    ).rejects.toThrow(ConflictException);
    expect(repo.save).toHaveBeenCalledTimes(2); // 1ª foi salva, 2ª falhou, 3ª nunca tentou
  });

  it('recusa (SLOT_NOT_AVAILABLE) o lote inteiro quando qualquer ocorrência é negada pelo Motor — nenhuma é criada', async () => {
    const repo: AppointmentRepository = { findById: vi.fn(), findActiveByTherapistAndRange: vi.fn(), save: vi.fn().mockResolvedValue(undefined), saveMany: vi.fn() };
    // Todas as N ocorrências são validadas ANTES de qualquer criação — a 2ª
    // falha, então nem a 1ª (que passaria) chega a ser salva.
    const verificarDisponibilidade = { execute: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) };
    const useCase = new CriarAgendamentoRecorrenteUseCase(repo, verificarDisponibilidade as never, tenantContext(), { recordAll: vi.fn().mockResolvedValue(undefined) } as never, { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never);
    await expect(
      useCase.execute({
        patientId: 'p1',
        therapistId: 't1',
        firstScheduledAt: new Date('2026-08-03T09:00:00'),
        modality: 'presencial',
        occurrences: 3,
        intervalDays: 7,
      }),
    ).rejects.toThrow(SlotNotAvailableError);
    expect(repo.save).not.toHaveBeenCalled(); // lote inteiro recusado, zero ocorrências criadas
    expect(verificarDisponibilidade.execute).toHaveBeenCalledTimes(2); // parou de validar assim que a 2ª recusou
    expect(verificarDisponibilidade.execute).not.toHaveBeenCalledTimes(3); // nunca chegou a validar a 3ª
  });
});

/**
 * Tarefa 06 da auditoria (AD-032) — o paciente tem de ser da própria
 * clínica. `findById` do repositório passa pela RLS: paciente de outra
 * clínica volta como inexistente.
 */
describe('Tarefa 06 — consulta só para paciente da própria clínica', () => {
  const TENANT = '11111111-1111-1111-1111-111111111111';
  const scheduledAt = new Date('2031-03-10T14:00:00.000Z');

  function setup(patientFound: boolean) {
    const context = new TenantContext();
    context.set(TENANT, 'user-1');
    const repo = { save: vi.fn().mockResolvedValue(undefined), saveMany: vi.fn().mockResolvedValue(undefined) };
    const motor = { execute: vi.fn().mockResolvedValue(true) };
    const audit = { recordAll: vi.fn().mockResolvedValue(undefined) };
    const patientRepo = { findById: vi.fn().mockResolvedValue(patientFound ? { id: 'p1' } : null) };
    return { context, repo, motor, audit, patientRepo };
  }

  it('AgendarConsultaUseCase: paciente não encontrado — 404, o Motor nem é consultado e nada é gravado', async () => {
    const { context, repo, motor, audit, patientRepo } = setup(false);
    const useCase = new AgendarConsultaUseCase(repo as never, motor as never, audit as never, context, patientRepo as never);

    await expect(useCase.execute({ patientId: 'p-de-outra-clinica', therapistId: 't1', scheduledAt, modality: 'presencial' })).rejects.toMatchObject({ status: 404 });

    expect(patientRepo.findById).toHaveBeenCalledWith('p-de-outra-clinica');
    expect(motor.execute).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    expect(audit.recordAll).not.toHaveBeenCalled();
  });

  it('AgendarConsultaUseCase: paciente da clínica — segue para o Motor e grava', async () => {
    const { context, repo, motor, audit, patientRepo } = setup(true);
    const useCase = new AgendarConsultaUseCase(repo as never, motor as never, audit as never, context, patientRepo as never);

    const appointment = await useCase.execute({ patientId: 'p1', therapistId: 't1', scheduledAt, modality: 'presencial' });

    expect(appointment.state).toBe('Reservada');
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it('CriarAgendamentoRecorrenteUseCase: paciente não encontrado — 404 e nenhuma ocorrência é gravada', async () => {
    const { context, repo, motor, audit, patientRepo } = setup(false);
    const useCase = new CriarAgendamentoRecorrenteUseCase(repo as never, motor as never, context, audit as never, patientRepo as never);

    await expect(
      useCase.execute({ patientId: 'p-de-outra-clinica', therapistId: 't1', firstScheduledAt: scheduledAt, modality: 'presencial', occurrences: 3, intervalDays: 7 }),
    ).rejects.toMatchObject({ status: 404 });

    expect(motor.execute).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.saveMany).not.toHaveBeenCalled();
  });
});

describe('Consulta de quem? — conferência de dono para quem age em nome de um paciente (ADR-0063, AD-038)', () => {
  function repoWith(appointment: Appointment) {
    const repo = { findById: vi.fn().mockResolvedValue(appointment), findActiveByTherapistAndRange: vi.fn(), save: vi.fn().mockResolvedValue(undefined), saveMany: vi.fn() };
    // Só o que estes Casos de Uso chamam; o resto do repositório não entra na conta.
    return repo as typeof repo & AppointmentRepository;
  }
  const audit = () => ({ recordAll: vi.fn().mockResolvedValue(undefined) }) as never;

  it('cancelar a consulta de OUTRO paciente responde "não encontrado" e não grava nada', async () => {
    const appointment = fakeAppointment('Reservada');
    const repo = repoWith(appointment);
    const useCase = new CancelarConsultaUseCase(repo, audit());

    await expect(useCase.execute('a1', { expectedPatientId: 'p-outro' })).rejects.toThrow(NotFoundException);

    expect(appointment.state).toBe('Reservada');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('confirmar a consulta de OUTRO paciente não confirma nem cria sessão', async () => {
    const appointment = fakeAppointment('Reservada');
    const repo = repoWith(appointment);
    const sessionRepo = { findById: vi.fn(), save: vi.fn(), findSummaries: vi.fn() };
    const useCase = new ConfirmarConsultaUseCase(repo, sessionRepo as never, audit());

    await expect(useCase.execute('a1', { expectedPatientId: 'p-outro' })).rejects.toThrow(NotFoundException);

    expect(appointment.state).toBe('Reservada');
    expect(repo.save).not.toHaveBeenCalled();
    expect(sessionRepo.save).not.toHaveBeenCalled();
  });

  it('remarcar a consulta de OUTRO paciente não consulta o Motor nem muda o horário', async () => {
    const appointment = fakeAppointment('Reservada');
    const repo = repoWith(appointment);
    const motor = motorDisponivel();
    const useCase = new RemarcarConsultaUseCase(repo, motor as never, audit());

    await expect(useCase.execute('a1', new Date('2026-08-04T10:00:00'), { expectedPatientId: 'p-outro' })).rejects.toThrow(NotFoundException);

    expect(motor.execute).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    expect(appointment.scheduledAt).toEqual(new Date('2026-08-03T09:00:00'));
  });

  it('a recusa é a mesma de uma consulta inexistente — não confirma a ninguém que o id existe', async () => {
    const existing = new CancelarConsultaUseCase(repoWith(fakeAppointment('Reservada')), audit());
    const missing = new CancelarConsultaUseCase({ findById: vi.fn().mockResolvedValue(null), save: vi.fn() } as never, audit());

    const wrongOwner = await existing.execute('a1', { expectedPatientId: 'p-outro' }).catch((error: Error) => error.message);
    const notFound = await missing.execute('a1', { expectedPatientId: 'p1' }).catch((error: Error) => error.message);

    expect(wrongOwner).toBe(notFound);
  });

  it('do próprio paciente: age normalmente', async () => {
    const appointment = fakeAppointment('Reservada');
    const useCase = new CancelarConsultaUseCase(repoWith(appointment), audit());

    await useCase.execute('a1', { expectedPatientId: 'p1' });

    expect(appointment.state).toBe('Cancelada');
  });

  it('sem informar de quem (rotas do painel): comportamento de antes', async () => {
    const appointment = fakeAppointment('Reservada');
    const useCase = new CancelarConsultaUseCase(repoWith(appointment), audit());

    await useCase.execute('a1');

    expect(appointment.state).toBe('Cancelada');
  });
});
