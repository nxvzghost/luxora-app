import { Patient } from '@domain/patient/patient.entity';

/**
 * PatientRepository — porta (interface). A implementação real (Prisma) vive
 * em infrastructure/, nunca aqui — domain-services/ não pode importar
 * infrastructure/ (regra de dependência arquitetural, ver
 * packages/config/eslint-preset.js).
 */
export interface PatientRepository {
  findById(id: string): Promise<Patient | null>;
  findAllByTenant(params?: { cursor?: string; limit?: number }): Promise<Patient[]>;
  save(patient: Patient): Promise<void>;
  /**
   * ADR-0053 §2.4 — resolve patientId a partir do número de WhatsApp do
   * remetente. Mínimo, determinístico: `phone` não é único hoje (achado de
   * PD-007, dívida pré-existente fora de escopo) — devolve a primeira
   * ocorrência, nunca lança em caso de duplicidade.
   */
  findByPhone(phone: string): Promise<Patient | null>;
  /** Epic 11 — contagem agregada no banco, para GET /dashboard/summary. */
  countActiveByTenant(): Promise<number>;
}

export const PATIENT_REPOSITORY = Symbol('PATIENT_REPOSITORY');
