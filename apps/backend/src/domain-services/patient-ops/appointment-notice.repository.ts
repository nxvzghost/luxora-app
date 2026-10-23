import { AppointmentNotice } from '@domain/appointment/appointment-notice';

/**
 * K2-b (ADR-0069, seção 3.2) — comunicações do paciente, somente acréscimo.
 * Nesta fase só há gravação: a leitura e a revisão (N2) são das fases
 * seguintes.
 */
export interface AppointmentNoticeRepository {
  insert(notice: AppointmentNotice): Promise<void>;
}

export const APPOINTMENT_NOTICE_REPOSITORY = Symbol('APPOINTMENT_NOTICE_REPOSITORY');
