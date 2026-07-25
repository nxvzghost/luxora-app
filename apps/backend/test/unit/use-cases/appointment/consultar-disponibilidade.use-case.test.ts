import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ConsultarDisponibilidadeUseCase } from '@use-cases/appointment/consultar-disponibilidade.use-case';
import { Therapist } from '@domain/therapist/therapist.entity';
import { AvailabilityCalendar } from '@domain/availability/availability-calendar.entity';
import { ClinicHoliday } from '@domain/availability/clinic-holiday.entity';
import { Appointment } from '@domain/appointment/appointment.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function fakeTherapist() {
  return Therapist.create({ id: 't1', tenantId: TENANT_ID, name: 'Dra. Ana' });
}

// 2026-08-03 é uma segunda-feira
function calendarWithMondayMorning(sessionDurationMinutes = 50) {
  const cal = AvailabilityCalendar.create({ id: 'cal1', tenantId: TENANT_ID, therapistId: 't1' });
  cal.setWindows([{ dayOfWeek: 1, startTime: '09:00', endTime: '11:00', sessionDurationMinutes }]);
  return cal;
}

function makeUseCase(
  therapist: Therapist | null,
  calendar: AvailabilityCalendar | null,
  appointments: Appointment[] = [],
  holidays: ClinicHoliday[] = [],
) {
  const appointmentRepo = {
    findById: vi.fn(),
    findActiveByTherapistAndRange: vi.fn().mockResolvedValue(appointments),
    save: vi.fn(),
    saveMany: vi.fn(),
  };
  const availabilityRepo = { findByTherapistId: vi.fn().mockResolvedValue(calendar), save: vi.fn() };
  const therapistRepo = { findById: vi.fn().mockResolvedValue(therapist), findAllByTenant: vi.fn(), save: vi.fn() };
  const clinicHolidayRepo = { findByTenantAndRange: vi.fn().mockResolvedValue(holidays), save: vi.fn() };
  const useCase = new ConsultarDisponibilidadeUseCase(appointmentRepo, availabilityRepo, therapistRepo, clinicHolidayRepo);
  return { useCase, appointmentRepo, availabilityRepo, therapistRepo, clinicHolidayRepo };
}

describe('ConsultarDisponibilidadeUseCase — reescrito sobre o Motor (ADR-0040)', () => {
  it('lança NotFoundException quando o terapeuta não existe', async () => {
    const { useCase } = makeUseCase(null, null);
    await expect(
      useCase.execute('t-inexistente', new Date('2026-08-03'), new Date('2026-08-03')),
    ).rejects.toThrow(NotFoundException);
  });

  it('retorna lista vazia quando o Terapeuta ainda não tem AvailabilityCalendar configurado', async () => {
    const { useCase } = makeUseCase(fakeTherapist(), null);
    const slots = await useCase.execute('t1', new Date('2026-08-03'), new Date('2026-08-03T23:59:59'));
    expect(slots).toHaveLength(0);
  });

  it('NÃO consulta ClinicHolidayRepository quando o AvailabilityCalendar sequer existe', async () => {
    const { useCase, clinicHolidayRepo } = makeUseCase(fakeTherapist(), null);
    await useCase.execute('t1', new Date('2026-08-03'), new Date('2026-08-03T23:59:59'));
    expect(clinicHolidayRepo.findByTenantAndRange).not.toHaveBeenCalled();
  });

  it('gera slots com a duração real da janela (50min dentro de 09:00-11:00 → 2 slots)', async () => {
    const { useCase } = makeUseCase(fakeTherapist(), calendarWithMondayMorning(50));
    const slots = await useCase.execute('t1', new Date('2026-08-03T00:00:00'), new Date('2026-08-03T23:59:59'));
    expect(slots).toHaveLength(2); // 09:00-09:50 e 09:50-10:40
  });

  it('usa a duração de 60min quando configurada na janela (09:00-11:00 → 2 slots, em posições diferentes)', async () => {
    const { useCase } = makeUseCase(fakeTherapist(), calendarWithMondayMorning(60));
    const slots = await useCase.execute('t1', new Date('2026-08-03T00:00:00'), new Date('2026-08-03T23:59:59'));
    expect(slots).toHaveLength(2);
    expect(slots[1].startsAt.getMinutes()).toBe(0); // prova que não é mais o passo de 50min
  });

  it('não gera slot algum em dia sem disponibilidade configurada', async () => {
    const { useCase } = makeUseCase(fakeTherapist(), calendarWithMondayMorning());
    // 2026-08-04 é terça-feira — sem janela configurada
    const slots = await useCase.execute('t1', new Date('2026-08-04T00:00:00'), new Date('2026-08-04T23:59:59'));
    expect(slots).toHaveLength(0);
  });

  it('exclui slot que colide com agendamento ativo existente', async () => {
    const existing = Appointment.reconstitute({
      id: 'a1',
      tenantId: TENANT_ID,
      patientId: 'p1',
      therapistId: 't1',
      scheduledAt: new Date('2026-08-03T09:00:00'),
      modality: 'presencial',
      state: 'Confirmada',
      recurring: false,
    });
    const { useCase } = makeUseCase(fakeTherapist(), calendarWithMondayMorning(), [existing]);
    const slots = await useCase.execute('t1', new Date('2026-08-03T00:00:00'), new Date('2026-08-03T23:59:59'));
    // Só o slot das 09:50 deveria sobrar (09:00 está ocupado)
    expect(slots).toHaveLength(1);
    expect(slots[0].startsAt.getHours()).toBe(9);
    expect(slots[0].startsAt.getMinutes()).toBe(50);
  });

  describe('ClinicHoliday — precedência de negócio sobre AvailabilityException e AvailabilityWindow (PD-001 Fase 2, B4)', () => {
    it('remove da lista os slots candidatos que caem num feriado da Clínica, mesmo com a janela permitindo', async () => {
      const holiday = ClinicHoliday.create({
        id: 'h1',
        tenantId: TENANT_ID,
        from: new Date('2026-08-03T00:00:00'),
        to: new Date('2026-08-04T00:00:00'),
      });
      const { useCase } = makeUseCase(fakeTherapist(), calendarWithMondayMorning(50), [], [holiday]);
      const slots = await useCase.execute('t1', new Date('2026-08-03T00:00:00'), new Date('2026-08-03T23:59:59'));
      expect(slots).toHaveLength(0);
    });

    it('consulta ClinicHolidayRepository com o tenantId vindo do AvailabilityCalendar', async () => {
      const { useCase, clinicHolidayRepo } = makeUseCase(fakeTherapist(), calendarWithMondayMorning());
      await useCase.execute('t1', new Date('2026-08-03T00:00:00'), new Date('2026-08-03T23:59:59'));
      expect(clinicHolidayRepo.findByTenantAndRange).toHaveBeenCalledWith(
        TENANT_ID,
        expect.any(Date),
        expect.any(Date),
      );
    });

    it('sem nenhum ClinicHoliday, comportamento idêntico ao de antes desta tarefa (sem regressão)', async () => {
      const { useCase } = makeUseCase(fakeTherapist(), calendarWithMondayMorning(50), [], []);
      const slots = await useCase.execute('t1', new Date('2026-08-03T00:00:00'), new Date('2026-08-03T23:59:59'));
      expect(slots).toHaveLength(2);
    });
  });
});
