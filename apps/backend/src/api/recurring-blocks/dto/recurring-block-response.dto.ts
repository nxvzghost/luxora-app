import { RecurringBlock } from '@domain/availability/recurring-block.entity';

export class RecurringBlockResponseDto {
  id!: string;
  tenantId!: string;
  patientId!: string;
  therapistId!: string;
  firstOccurrence!: Date;
  intervalDays!: number;
  modality!: 'presencial' | 'online';
  renewalMode!: 'automatic' | 'manual';

  static fromDomain(block: RecurringBlock): RecurringBlockResponseDto {
    const dto = new RecurringBlockResponseDto();
    dto.id = block.id;
    dto.tenantId = block.tenantId;
    dto.patientId = block.patientId;
    dto.therapistId = block.therapistId;
    dto.firstOccurrence = block.firstOccurrence;
    dto.intervalDays = block.intervalDays;
    dto.modality = block.modality;
    dto.renewalMode = block.renewalMode;
    return dto;
  }
}
