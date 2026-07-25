import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { ScheduleSlot } from '@domain/availability/schedule-slot.value-object';
import {
  AppointmentRepository,
  APPOINTMENT_REPOSITORY,
} from '@domain-services/patient-ops/appointment.repository';
import { THERAPIST_REPOSITORY, TherapistRepository } from '@domain-services/platform/therapist.repository';
import { AVAILABILITY_REPOSITORY, AvailabilityRepository } from '@domain-services/availability/availability.repository';
import { CLINIC_HOLIDAY_REPOSITORY, ClinicHolidayRepository } from '@domain-services/availability/clinic-holiday.repository';

export interface AvailableSlot {
  startsAt: Date;
  endsAt: Date;
}

/**
 * ConsultarDisponibilidadeUseCase — RF-043, RF-058. Reescrito sobre o Motor
 * de Disponibilidade (ADR-0040, PD-001): lista os horários livres reais de
 * um Terapeuta, combinando o `AvailabilityCalendar` dele (janelas + duração
 * real por janela, por terapeuta) com os agendamentos ativos já existentes
 * no período.
 *
 * Precedência de negócio (PD-001 Fase 2, B4): `ClinicHoliday` (Clínica) >
 * `AvailabilityException` (Terapeuta) > `AvailabilityWindow`. `ClinicHoliday`
 * é bloqueio EXTERNO ao `AvailabilityCalendar` — os slots candidatos que
 * caem num feriado são removidos aqui, na camada de aplicação, nunca dentro
 * do Aggregate.
 *
 * Base para o Padrão 3 do agente de IA (05-IA/01-Tom-de-Voz...): "sempre
 * consulta a disponibilidade real antes de responder — nunca promete
 * horário sem checar o sistema primeiro".
 */
@Injectable()
export class ConsultarDisponibilidadeUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointmentRepo: AppointmentRepository,
    @Inject(AVAILABILITY_REPOSITORY) private readonly availabilityRepo: AvailabilityRepository,
    @Inject(THERAPIST_REPOSITORY) private readonly therapistRepo: TherapistRepository,
    @Inject(CLINIC_HOLIDAY_REPOSITORY) private readonly clinicHolidayRepo: ClinicHolidayRepository,
  ) {}

  async execute(therapistId: string, from: Date, to: Date): Promise<AvailableSlot[]> {
    const therapist = await this.therapistRepo.findById(therapistId);
    if (!therapist) {
      throw new NotFoundException('Terapeuta não encontrado.');
    }

    const calendar = await this.availabilityRepo.findByTherapistId(therapistId);
    if (!calendar) {
      return []; // sem AvailabilityCalendar configurado — nenhum horário disponível
    }

    // tenantId vem do próprio Aggregate já carregado — nunca de contexto implícito.
    const holidays = await this.clinicHolidayRepo.findByTenantAndRange(calendar.tenantId, from, to);

    const candidateSlots = calendar
      .generateCandidateSlots(from, to)
      .filter((candidate) => !holidays.some((holiday) => holiday.overlaps(candidate.startsAt, candidate.endsAt)));

    const activeAppointments = await this.appointmentRepo.findActiveByTherapistAndRange(therapistId, from, to);
    const bookedSlots = activeAppointments.map((appointment) => {
      const durationMinutes = calendar.durationMinutesFor(appointment.scheduledAt);
      return ScheduleSlot.free(
        therapistId,
        appointment.scheduledAt,
        new Date(appointment.scheduledAt.getTime() + durationMinutes * 60_000),
      );
    });

    return candidateSlots
      .filter((candidate) => !bookedSlots.some((booked) => candidate.overlapsWith(booked)))
      .map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt }));
  }
}
