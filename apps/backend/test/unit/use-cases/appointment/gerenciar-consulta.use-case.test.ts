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

describe('AgendarConsultaUseCase', () => {
  it('cria o agendamento já no estado Reservada', async () => {
    const repo: AppointmentRepository = { findById: vi.fn(), findActiveByTherapistAndRange: vi.fn(), save: vi.fn().mockResolvedValue(undefined) };
    const useCase = new AgendarConsultaUseCase(repo, { recordAll: vi.fn().mockResolvedValue(undefined) } as never, tenantContext());
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
    };
    const useCase = new AgendarConsultaUseCase(repo, { recordAll: vi.fn().mockResolvedValue(undefined) } as never, tenantContext());
    await expect(
      useCase.execute({ patientId: 'p1', therapistId: 't1', scheduledAt: new Date(), modality: 'presencial' }),
    ).rejects.toThrow(ConflictException);
  });
});

describe('RemarcarConsultaUseCase', () => {
  it('orquestra as duas transições da entidade (ReagendamentoSolicitado → Reagendada) em uma única chamada', async () => {
    const repo: AppointmentRepository = {
      findById: vi.fn().mockResolvedValue(fakeAppointment('Confirmada')),
      findActiveByTherapistAndRange: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const useCase = new RemarcarConsultaUseCase(repo, { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const appointment = await useCase.execute('a1', new Date('2026-08-10T09:00:00'));
    expect(appointment.state).toBe('Reagendada');
  });

  it('lança NotFoundException quando o agendamento não existe', async () => {
    const repo: AppointmentRepository = { findById: vi.fn().mockResolvedValue(null), findActiveByTherapistAndRange: vi.fn(), save: vi.fn() };
    const useCase = new RemarcarConsultaUseCase(repo, { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    await expect(useCase.execute('a-inexistente', new Date())).rejects.toThrow(NotFoundException);
  });
});

describe('CancelarConsultaUseCase', () => {
  it('transiciona para Cancelada', async () => {
    const repo: AppointmentRepository = {
      findById: vi.fn().mockResolvedValue(fakeAppointment('Reservada')),
      findActiveByTherapistAndRange: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const useCase = new CancelarConsultaUseCase(repo, { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const appointment = await useCase.execute('a1');
    expect(appointment.state).toBe('Cancelada');
  });
});

describe('ConfirmarConsultaUseCase', () => {
  it('transiciona para Confirmada', async () => {
    const repo: AppointmentRepository = {
      findById: vi.fn().mockResolvedValue(fakeAppointment('Reservada')),
      findActiveByTherapistAndRange: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const useCase = new ConfirmarConsultaUseCase(repo, { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const appointment = await useCase.execute('a1');
    expect(appointment.state).toBe('Confirmada');
  });
});

describe('CriarAgendamentoRecorrenteUseCase', () => {
  it('cria N ocorrências espaçadas por intervalDays', async () => {
    const repo: AppointmentRepository = { findById: vi.fn(), findActiveByTherapistAndRange: vi.fn(), save: vi.fn().mockResolvedValue(undefined) };
    const useCase = new CriarAgendamentoRecorrenteUseCase(repo, tenantContext(), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
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
    const repo: AppointmentRepository = { findById: vi.fn(), findActiveByTherapistAndRange: vi.fn(), save: vi.fn() };
    const useCase = new CriarAgendamentoRecorrenteUseCase(repo, tenantContext(), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
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
    };
    const useCase = new CriarAgendamentoRecorrenteUseCase(repo, tenantContext(), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
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
});
