import { AppointmentDecisionRecord, AppointmentOutcomeRecord } from '@domain/appointment/appointment-outcome';

/**
 * K2-b (ADR-0069, seções 2.4 e 3.2b) — desfecho da consulta e o histórico de
 * decisões sobre ele.
 *
 * O desfecho é gravado uma vez (`insert`) e depois só muda nas colunas de
 * desfecho e de decisão (`saveDecision`): o retrato, a consulta, a clínica e
 * a autoria do registro nunca são reescritos, e o papel da aplicação não tem
 * privilégio para isso nem para apagar a linha.
 */
export interface AppointmentOutcomeRepository {
  findByAppointmentId(appointmentId: string): Promise<AppointmentOutcomeRecord | null>;
  /** O desfecho com a linha travada até o fim da unidade de trabalho — decisões uma por vez. */
  findByAppointmentIdForUpdate(appointmentId: string): Promise<AppointmentOutcomeRecord | null>;
  /** Desfechos de várias consultas, para a listagem da agenda. */
  findByAppointmentIds(appointmentIds: string[]): Promise<Map<string, AppointmentOutcomeRecord>>;
  /** Lança APPOINTMENT_OUTCOME_CONFLICT se a consulta já tiver desfecho (corrida entre dois registros). */
  insert(record: AppointmentOutcomeRecord): Promise<void>;
  saveDecision(record: AppointmentOutcomeRecord): Promise<void>;
  /** Somente acréscimo: o motivo de cada decisão fica guardado. */
  insertDecision(decision: AppointmentDecisionRecord): Promise<void>;
}

export const APPOINTMENT_OUTCOME_REPOSITORY = Symbol('APPOINTMENT_OUTCOME_REPOSITORY');
