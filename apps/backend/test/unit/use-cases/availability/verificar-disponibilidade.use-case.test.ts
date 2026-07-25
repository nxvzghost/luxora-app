import { describe, it, expect, vi } from 'vitest';
import { VerificarDisponibilidadeUseCase } from '@use-cases/availability/verificar-disponibilidade.use-case';
import { AvailabilityCalendar } from '@domain/availability/availability-calendar.entity';
import { ClinicHoliday } from '@domain/availability/clinic-holiday.entity';
import { Appointment } from '@domain/appointment/appointment.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

// 2026-08-03 é uma segunda-feira
function calendarWithMondayMorning(sessionDurationMinutes = 50) {
  const cal = AvailabilityCalendar.create({ id: 'cal1', tenantId: TENANT_ID, therapistId: 't1' });
  cal.setWindows([{ dayOfWeek: 1, startTime: '09:00', endTime: '11:00', sessionDurationMinutes }]);
  return cal;
}

function fakeAppointment(id: string, scheduledAt: Date) {
  return Appointment.reconstitute({
    id,
    tenantId: TENANT_ID,
    patientId: 'p1',
    therapistId: 't1',
    scheduledAt,
    modality: 'presencial',
    state: 'Confirmada',
    recurring: false,
  });
}

function makeUseCase(
  calendar: AvailabilityCalendar | null,
  appointments: Appointment[] = [],
  holidays: ClinicHoliday[] = [],
) {
  const availabilityRepo = { findByTherapistId: vi.fn().mockResolvedValue(calendar), save: vi.fn() };
  const appointmentRepo = {
    findById: vi.fn(),
    findActiveByTherapistAndRange: vi.fn().mockResolvedValue(appointments),
    save: vi.fn(),
    saveMany: vi.fn(),
  };
  const clinicHolidayRepo = { findByTenantAndRange: vi.fn().mockResolvedValue(holidays), save: vi.fn() };
  const useCase = new VerificarDisponibilidadeUseCase(availabilityRepo, appointmentRepo, clinicHolidayRepo);
  return { useCase, availabilityRepo, appointmentRepo, clinicHolidayRepo };
}

describe('VerificarDisponibilidadeUseCase — o gate central do Motor (ADR-0040)', () => {
  it('false quando o Terapeuta não tem AvailabilityCalendar configurado', async () => {
    const { useCase } = makeUseCase(null);
    const result = await useCase.execute({ therapistId: 't1', scheduledAt: new Date('2026-08-03T09:00:00') });
    expect(result).toBe(false);
  });

  it('NÃO consulta ClinicHolidayRepository quando o AvailabilityCalendar sequer existe', async () => {
    const { useCase, clinicHolidayRepo } = makeUseCase(null);
    await useCase.execute({ therapistId: 't1', scheduledAt: new Date('2026-08-03T09:00:00') });
    expect(clinicHolidayRepo.findByTenantAndRange).not.toHaveBeenCalled();
  });

  it('true quando o horário está dentro da janela e sem conflito', async () => {
    const { useCase } = makeUseCase(calendarWithMondayMorning());
    const result = await useCase.execute({ therapistId: 't1', scheduledAt: new Date('2026-08-03T09:00:00') });
    expect(result).toBe(true);
  });

  it('false quando o horário está fora da janela do Terapeuta', async () => {
    const { useCase } = makeUseCase(calendarWithMondayMorning());
    // terça-feira, sem janela configurada
    const result = await useCase.execute({ therapistId: 't1', scheduledAt: new Date('2026-08-04T09:00:00') });
    expect(result).toBe(false);
  });

  it('false quando colide com um Appointment ativo já existente', async () => {
    const existing = fakeAppointment('a1', new Date('2026-08-03T09:00:00'));
    const { useCase } = makeUseCase(calendarWithMondayMorning(), [existing]);
    const result = await useCase.execute({ therapistId: 't1', scheduledAt: new Date('2026-08-03T09:00:00') });
    expect(result).toBe(false);
  });

  it('true quando o único Appointment em conflito é o próprio (excludeAppointmentId) — caso de reagendamento', async () => {
    const existing = fakeAppointment('a1', new Date('2026-08-03T09:00:00'));
    const { useCase } = makeUseCase(calendarWithMondayMorning(), [existing]);
    const result = await useCase.execute({
      therapistId: 't1',
      scheduledAt: new Date('2026-08-03T09:00:00'),
      excludeAppointmentId: 'a1',
    });
    expect(result).toBe(true);
  });

  it('usa a duração real da janela (50min) para calcular o fim do slot consultado', async () => {
    const { useCase } = makeUseCase(calendarWithMondayMorning(50));
    // 09:50-10:40 cabe dentro de 09:00-11:00 com passo de 50min
    const result = await useCase.execute({ therapistId: 't1', scheduledAt: new Date('2026-08-03T09:50:00') });
    expect(result).toBe(true);
  });

  describe('ClinicHoliday — precedência de negócio sobre AvailabilityException e AvailabilityWindow (PD-001 Fase 2, B4)', () => {
    it('recusa quando há ClinicHoliday cobrindo a data, mesmo com a janela permitindo e sem nenhum Appointment em conflito', async () => {
      const holiday = ClinicHoliday.create({
        id: 'h1',
        tenantId: TENANT_ID,
        from: new Date('2026-08-03T00:00:00'),
        to: new Date('2026-08-04T00:00:00'),
      });
      const { useCase } = makeUseCase(calendarWithMondayMorning(), [], [holiday]);
      const result = await useCase.execute({ therapistId: 't1', scheduledAt: new Date('2026-08-03T09:00:00') });
      expect(result).toBe(false);
    });

    it('consulta ClinicHolidayRepository com o tenantId vindo do AvailabilityCalendar, não de um valor arbitrário', async () => {
      const { useCase, clinicHolidayRepo } = makeUseCase(calendarWithMondayMorning());
      await useCase.execute({ therapistId: 't1', scheduledAt: new Date('2026-08-03T09:00:00') });
      expect(clinicHolidayRepo.findByTenantAndRange).toHaveBeenCalledWith(
        TENANT_ID,
        expect.any(Date),
        expect.any(Date),
      );
    });

    it('sem nenhum ClinicHoliday, comportamento idêntico ao de antes desta tarefa (sem regressão)', async () => {
      const { useCase } = makeUseCase(calendarWithMondayMorning(), [], []);
      const result = await useCase.execute({ therapistId: 't1', scheduledAt: new Date('2026-08-03T09:00:00') });
      expect(result).toBe(true);
    });
  });
});
