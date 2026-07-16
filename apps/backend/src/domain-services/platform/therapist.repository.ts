import { Therapist } from '@domain/therapist/therapist.entity';

export interface TherapistRepository {
  findById(id: string): Promise<Therapist | null>;
  findAllByTenant(): Promise<Therapist[]>;
  save(therapist: Therapist): Promise<void>;
}

export const THERAPIST_REPOSITORY = Symbol('THERAPIST_REPOSITORY');
