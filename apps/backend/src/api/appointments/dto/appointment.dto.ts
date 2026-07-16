import { IsString, IsDateString, IsIn, IsOptional, IsBoolean, IsInt, Min } from 'class-validator';

export class CreateAppointmentDto {
  @IsString()
  patientId!: string;

  @IsString()
  therapistId!: string;

  @IsDateString()
  scheduledAt!: string;

  @IsIn(['presencial', 'online'])
  modality!: 'presencial' | 'online';

  @IsOptional()
  @IsBoolean()
  recurring?: boolean;
}

export class RescheduleAppointmentDto {
  @IsDateString()
  newScheduledAt!: string;
}

export class RecurringAppointmentDto {
  @IsString()
  patientId!: string;

  @IsString()
  therapistId!: string;

  @IsDateString()
  firstScheduledAt!: string;

  @IsIn(['presencial', 'online'])
  modality!: 'presencial' | 'online';

  @IsInt()
  @Min(1)
  occurrences!: number;

  @IsInt()
  @Min(1)
  intervalDays!: number;
}
