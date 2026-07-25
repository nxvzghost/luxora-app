import { IsString, IsDateString, IsIn, IsInt, Min } from 'class-validator';

export class CreateRecurringBlockDto {
  @IsString()
  patientId!: string;

  @IsString()
  therapistId!: string;

  @IsDateString()
  firstOccurrence!: string;

  @IsInt()
  @Min(1)
  intervalDays!: number;

  @IsIn(['presencial', 'online'])
  modality!: 'presencial' | 'online';

  @IsIn(['automatic', 'manual'])
  renewalMode!: 'automatic' | 'manual';
}
