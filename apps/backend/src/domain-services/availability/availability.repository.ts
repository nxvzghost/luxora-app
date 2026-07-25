import { AvailabilityCalendar } from '@domain/availability/availability-calendar.entity';

export interface AvailabilityRepository {
  findByTherapistId(therapistId: string): Promise<AvailabilityCalendar | null>;
  save(calendar: AvailabilityCalendar): Promise<void>;
}

export const AVAILABILITY_REPOSITORY = Symbol('AVAILABILITY_REPOSITORY');
