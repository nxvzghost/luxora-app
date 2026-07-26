import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import {
  ConsultarCalendarioUseCase,
  DefinirDisponibilidadeUseCase,
  DefinirExcecoesDisponibilidadeUseCase,
} from '@use-cases/availability/gerenciar-disponibilidade.use-case';
import { AvailabilityCalendar } from '@domain/availability/availability-calendar.entity';
import { Therapist } from '@domain/therapist/therapist.entity';
import { TenantContext } from '@shared/tenant-context';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function fakeCalendar() {
  return AvailabilityCalendar.create({ id: 'cal1', tenantId: TENANT_ID, therapistId: 't1' });
}

function fakeTherapist() {
  return Therapist.create({ id: 't1', tenantId: TENANT_ID, name: 'Dra. Ana' });
}

function tenantContext() {
  const tc = new TenantContext();
  tc.set(TENANT_ID, 'user-1');
  return tc;
}

describe('ConsultarCalendarioUseCase', () => {
  it('retorna o calendário quando encontrado', async () => {
    const repo = { findByTherapistId: vi.fn().mockResolvedValue(fakeCalendar()), save: vi.fn() };
    const useCase = new ConsultarCalendarioUseCase(repo);
    const calendar = await useCase.execute('t1');
    expect(calendar.therapistId).toBe('t1');
  });

  it('lança NotFoundException quando o Terapeuta não tem calendário configurado', async () => {
    const repo = { findByTherapistId: vi.fn().mockResolvedValue(null), save: vi.fn() };
    const useCase = new ConsultarCalendarioUseCase(repo);
    await expect(useCase.execute('t1')).rejects.toThrow(NotFoundException);
  });
});

describe('DefinirDisponibilidadeUseCase', () => {
  it('lança NotFoundException quando o Terapeuta não existe', async () => {
    const availabilityRepo = { findByTherapistId: vi.fn(), save: vi.fn() };
    const therapistRepo = { findById: vi.fn().mockResolvedValue(null), findAllByTenant: vi.fn(), save: vi.fn() };
    const useCase = new DefinirDisponibilidadeUseCase(availabilityRepo, therapistRepo, tenantContext(), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    await expect(
      useCase.execute('t1', [{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00', sessionDurationMinutes: 60 }]),
    ).rejects.toThrow(NotFoundException);
  });

  it('cria um AvailabilityCalendar novo quando o Terapeuta ainda não tinha um', async () => {
    const availabilityRepo = { findByTherapistId: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue(undefined) };
    const therapistRepo = { findById: vi.fn().mockResolvedValue(fakeTherapist()), findAllByTenant: vi.fn(), save: vi.fn() };
    const useCase = new DefinirDisponibilidadeUseCase(availabilityRepo, therapistRepo, tenantContext(), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const calendar = await useCase.execute('t1', [{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00', sessionDurationMinutes: 60 }]);
    expect(calendar.windows).toHaveLength(1);
    expect(availabilityRepo.save).toHaveBeenCalledOnce();
  });

  it('substitui as janelas de um AvailabilityCalendar já existente', async () => {
    const existing = fakeCalendar();
    existing.setWindows([{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00', sessionDurationMinutes: 60 }]);
    const availabilityRepo = { findByTherapistId: vi.fn().mockResolvedValue(existing), save: vi.fn().mockResolvedValue(undefined) };
    const therapistRepo = { findById: vi.fn().mockResolvedValue(fakeTherapist()), findAllByTenant: vi.fn(), save: vi.fn() };
    const useCase = new DefinirDisponibilidadeUseCase(availabilityRepo, therapistRepo, tenantContext(), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const calendar = await useCase.execute('t1', [{ dayOfWeek: 2, startTime: '14:00', endTime: '18:00', sessionDurationMinutes: 45 }]);
    expect(calendar.windows).toHaveLength(1);
    expect(calendar.windows[0].dayOfWeek).toBe(2);
  });

  it('propaga erro de validação da entidade (ex: sobreposição)', async () => {
    const availabilityRepo = { findByTherapistId: vi.fn().mockResolvedValue(null), save: vi.fn() };
    const therapistRepo = { findById: vi.fn().mockResolvedValue(fakeTherapist()), findAllByTenant: vi.fn(), save: vi.fn() };
    const useCase = new DefinirDisponibilidadeUseCase(availabilityRepo, therapistRepo, tenantContext(), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    await expect(
      useCase.execute('t1', [
        { dayOfWeek: 1, startTime: '09:00', endTime: '12:00', sessionDurationMinutes: 60 },
        { dayOfWeek: 1, startTime: '11:00', endTime: '14:00', sessionDurationMinutes: 60 },
      ]),
    ).rejects.toThrow(/sobreposta/);
  });
});

describe('DefinirExcecoesDisponibilidadeUseCase (AD-008)', () => {
  it('lança NotFoundException quando o Terapeuta não existe', async () => {
    const availabilityRepo = { findByTherapistId: vi.fn(), save: vi.fn() };
    const therapistRepo = { findById: vi.fn().mockResolvedValue(null), findAllByTenant: vi.fn(), save: vi.fn() };
    const useCase = new DefinirExcecoesDisponibilidadeUseCase(availabilityRepo, therapistRepo, tenantContext(), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    await expect(
      useCase.execute('t1', [{ from: new Date('2026-08-03T00:00:00'), to: new Date('2026-08-10T00:00:00') }]),
    ).rejects.toThrow(NotFoundException);
  });

  it('cria um AvailabilityCalendar novo quando o Terapeuta ainda não tinha um', async () => {
    const availabilityRepo = { findByTherapistId: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue(undefined) };
    const therapistRepo = { findById: vi.fn().mockResolvedValue(fakeTherapist()), findAllByTenant: vi.fn(), save: vi.fn() };
    const useCase = new DefinirExcecoesDisponibilidadeUseCase(availabilityRepo, therapistRepo, tenantContext(), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const calendar = await useCase.execute('t1', [{ from: new Date('2026-08-03T00:00:00'), to: new Date('2026-08-10T00:00:00') }]);
    expect(calendar.exceptions).toHaveLength(1);
    expect(availabilityRepo.save).toHaveBeenCalledOnce();
  });

  it('substitui as exceções de um AvailabilityCalendar já existente (nunca faz merge parcial)', async () => {
    const existing = fakeCalendar();
    existing.setExceptions([{ from: new Date('2026-08-03T00:00:00'), to: new Date('2026-08-10T00:00:00') }]);
    const availabilityRepo = { findByTherapistId: vi.fn().mockResolvedValue(existing), save: vi.fn().mockResolvedValue(undefined) };
    const therapistRepo = { findById: vi.fn().mockResolvedValue(fakeTherapist()), findAllByTenant: vi.fn(), save: vi.fn() };
    const useCase = new DefinirExcecoesDisponibilidadeUseCase(availabilityRepo, therapistRepo, tenantContext(), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    const calendar = await useCase.execute('t1', [{ from: new Date('2026-09-01T00:00:00'), to: new Date('2026-09-02T00:00:00') }]);
    expect(calendar.exceptions).toHaveLength(1);
    expect(calendar.exceptions[0].from.toISOString()).toBe(new Date('2026-09-01T00:00:00').toISOString());
  });

  it('propaga erro de validação da entidade (from >= to)', async () => {
    const availabilityRepo = { findByTherapistId: vi.fn().mockResolvedValue(null), save: vi.fn() };
    const therapistRepo = { findById: vi.fn().mockResolvedValue(fakeTherapist()), findAllByTenant: vi.fn(), save: vi.fn() };
    const useCase = new DefinirExcecoesDisponibilidadeUseCase(availabilityRepo, therapistRepo, tenantContext(), { recordAll: vi.fn().mockResolvedValue(undefined) } as never);
    await expect(
      useCase.execute('t1', [{ from: new Date('2026-08-10T00:00:00'), to: new Date('2026-08-03T00:00:00') }]),
    ).rejects.toThrow(/anterior ao fim/);
  });
});
