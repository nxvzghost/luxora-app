import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { ScheduleSlot } from '@domain/schedule/schedule-slot.value-object';
import {
  AppointmentRepository,
  APPOINTMENT_REPOSITORY,
} from '@domain-services/patient-ops/appointment.repository';
import { THERAPIST_REPOSITORY, TherapistRepository } from '@domain-services/platform/therapist.repository';
import { CLINIC_REPOSITORY, ClinicRepository } from '@domain-services/platform/clinic.repository';
import { ClinicNotFoundError } from '@domain-services/platform/clinic-not-found.error';

export interface AvailableSlot {
  startsAt: Date;
  endsAt: Date;
}

/**
 * ConsultarDisponibilidadeUseCase — RF-043, RF-058.
 *
 * Combina 3 fontes para chegar na disponibilidade real:
 * 1. Disponibilidade semanal recorrente do Terapeuta (Módulo 06)
 * 2. Duração padrão de sessão da Clínica (RF-013, adicionada neste módulo)
 * 3. Agendamentos ativos já existentes no período (nunca oferece horário ocupado)
 *
 * Base para o Padrão 3 do agente de IA (05-IA/01-Tom-de-Voz...): "sempre
 * consulta a disponibilidade real antes de responder — nunca promete
 * horário sem checar o sistema primeiro".
 */
@Injectable()
export class ConsultarDisponibilidadeUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointmentRepo: AppointmentRepository,
    @Inject(THERAPIST_REPOSITORY) private readonly therapistRepo: TherapistRepository,
    @Inject(CLINIC_REPOSITORY) private readonly clinicRepo: ClinicRepository,
  ) {}

  async execute(therapistId: string, tenantId: string, from: Date, to: Date): Promise<AvailableSlot[]> {
    const therapist = await this.therapistRepo.findById(therapistId);
    if (!therapist) {
      throw new NotFoundException('Terapeuta não encontrado.');
    }

    const clinic = await this.clinicRepo.findByTenantId(tenantId);
    if (!clinic) {
      throw new ClinicNotFoundError();
    }

    // Dívida fechada — Clinic agora expõe defaultSessionDurationMinutes de verdade.
    const durationMinutes = clinic.defaultSessionDurationMinutes;

    const candidateSlots = this.generateCandidateSlots(
      therapistId,
      therapist.availability,
      from,
      to,
      durationMinutes,
    );

    const activeAppointments = await this.appointmentRepo.findActiveByTherapistAndRange(therapistId, from, to);
    const bookedSlots = activeAppointments.map((a) =>
      ScheduleSlot.free(therapistId, a.scheduledAt, new Date(a.scheduledAt.getTime() + durationMinutes * 60_000)),
    );

    return candidateSlots
      .filter((candidate) => !bookedSlots.some((booked) => candidate.overlapsWith(booked)))
      .map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt }));
  }

  private generateCandidateSlots(
    therapistId: string,
    availability: readonly { dayOfWeek: number; startTime: string; endTime: string }[],
    from: Date,
    to: Date,
    durationMinutes: number,
  ): ScheduleSlot[] {
    const slots: ScheduleSlot[] = [];
    const cursor = new Date(from);
    cursor.setHours(0, 0, 0, 0);

    while (cursor <= to) {
      const dayAvailability = availability.filter((a) => a.dayOfWeek === cursor.getDay());
      for (const window of dayAvailability) {
        const [startH, startM] = window.startTime.split(':').map(Number);
        const [endH, endM] = window.endTime.split(':').map(Number);

        let slotStart = new Date(cursor);
        slotStart.setHours(startH, startM, 0, 0);
        const windowEnd = new Date(cursor);
        windowEnd.setHours(endH, endM, 0, 0);

        while (slotStart.getTime() + durationMinutes * 60_000 <= windowEnd.getTime()) {
          const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60_000);
          if (slotStart >= from && slotEnd <= to) {
            slots.push(ScheduleSlot.free(therapistId, slotStart, slotEnd));
          }
          slotStart = slotEnd;
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    return slots;
  }
}
