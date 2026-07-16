import { Appointment } from '@domain/appointment/appointment.entity';

export interface AppointmentRepository {
  findById(id: string): Promise<Appointment | null>;
  /** Busca agendamentos ativos (não cancelados) de um terapeuta num intervalo — base de ConsultarDisponibilidade. */
  findActiveByTherapistAndRange(therapistId: string, from: Date, to: Date): Promise<Appointment[]>;
  /** Módulo 15 — lista agendamentos do Tenant inteiro (todos os terapeutas) num intervalo, para a tela de Agenda. */
  findByTenantAndRange(from: Date, to: Date): Promise<Appointment[]>;
  save(appointment: Appointment): Promise<void>;
}

export const APPOINTMENT_REPOSITORY = Symbol('APPOINTMENT_REPOSITORY');
