import { Clinic } from '@domain/clinic/clinic.entity';

export interface ClinicRepository {
  findByTenantId(tenantId: string): Promise<Clinic | null>;
  save(clinic: Clinic): Promise<void>;
}

export const CLINIC_REPOSITORY = Symbol('CLINIC_REPOSITORY');
