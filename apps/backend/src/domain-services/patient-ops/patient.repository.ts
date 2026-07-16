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
}

export const PATIENT_REPOSITORY = Symbol('PATIENT_REPOSITORY');
