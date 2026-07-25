import { Injectable, Inject } from '@nestjs/common';
import { ScheduleSlot } from '@domain/availability/schedule-slot.value-object';
import { AVAILABILITY_REPOSITORY, AvailabilityRepository } from '@domain-services/availability/availability.repository';
import { CLINIC_HOLIDAY_REPOSITORY, ClinicHolidayRepository } from '@domain-services/availability/clinic-holiday.repository';
import {
  AppointmentRepository,
  APPOINTMENT_REPOSITORY,
} from '@domain-services/patient-ops/appointment.repository';

export interface VerificarDisponibilidadeInput {
  therapistId: string;
  scheduledAt: Date;
  /** Ao reagendar, o próprio Appointment que está sendo movido não deve contar como conflito consigo mesmo. */
  excludeAppointmentId?: string;
}

/**
 * VerificarDisponibilidadeUseCase — o gate central do Motor de
 * Disponibilidade (ADR-0040, PD-001). Todo Caso de Uso que cria ou altera um
 * Appointment consulta este gate ANTES de agir — nenhum atalho, nenhuma
 * exceção, nem mesmo para a IA (ver IntentActionRouter, que herda a
 * proteção por construção via AgendarConsultaUseCase).
 *
 * Precedência de negócio (PD-001 Fase 2, B4): `ClinicHoliday` (Clínica) >
 * `AvailabilityException` (Terapeuta) > `AvailabilityWindow`. `ClinicHoliday`
 * é um bloqueio EXTERNO ao `AvailabilityCalendar` — checado aqui, na camada
 * de aplicação, nunca movido para dentro do Aggregate (que continua
 * responsável só por `windows`/`exceptions`). `AvailabilityException` e
 * `AvailabilityWindow` continuam resolvidas internamente por
 * `calendar.isAvailable()`, como desde B1.
 */
@Injectable()
export class VerificarDisponibilidadeUseCase {
  constructor(
    @Inject(AVAILABILITY_REPOSITORY) private readonly availabilityRepo: AvailabilityRepository,
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointmentRepo: AppointmentRepository,
    @Inject(CLINIC_HOLIDAY_REPOSITORY) private readonly clinicHolidayRepo: ClinicHolidayRepository,
  ) {}

  async execute(input: VerificarDisponibilidadeInput): Promise<boolean> {
    const calendar = await this.availabilityRepo.findByTherapistId(input.therapistId);
    if (!calendar) return false; // sem AvailabilityCalendar configurado — nenhum horário é considerado livre

    const durationMinutes = calendar.durationMinutesFor(input.scheduledAt);
    const to = new Date(input.scheduledAt.getTime() + durationMinutes * 60_000);

    // tenantId vem do próprio Aggregate já carregado — nunca de contexto
    // implícito (mesma decisão de ClinicHolidayRepository, ver B3).
    const holidays = await this.clinicHolidayRepo.findByTenantAndRange(calendar.tenantId, input.scheduledAt, to);
    if (holidays.length > 0) return false;

    const activeAppointments = await this.appointmentRepo.findActiveByTherapistAndRange(
      input.therapistId,
      input.scheduledAt,
      to,
    );
    const bookedSlots = activeAppointments
      .filter((appointment) => appointment.id !== input.excludeAppointmentId)
      .map((appointment) => {
        const bookedDuration = calendar.durationMinutesFor(appointment.scheduledAt);
        return ScheduleSlot.free(
          input.therapistId,
          appointment.scheduledAt,
          new Date(appointment.scheduledAt.getTime() + bookedDuration * 60_000),
        );
      });

    return calendar.isAvailable(input.scheduledAt, to, bookedSlots);
  }
}
