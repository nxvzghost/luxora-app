import {
  IsString,
  IsOptional,
  MinLength,
  IsArray,
  ValidateNested,
  Min,
  Max,
  Matches,
  IsInt,
  IsPositive,
  IsISO8601,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateTherapistDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsOptional()
  @IsString()
  specialty?: string;

  @IsOptional()
  @IsString()
  phone?: string;
}

export class UpdateTherapistDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;
}

export class AvailabilityWindowDto {
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/)
  startTime!: string;

  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/)
  endTime!: string;

  @IsInt()
  @IsPositive()
  sessionDurationMinutes!: number;
}

export class SetAvailabilityDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AvailabilityWindowDto)
  windows!: AvailabilityWindowDto[];
}

/** AD-008 — `from`/`to` como string ISO 8601; conversão para `Date` acontece no Controller, mesmo padrão de `CreateAppointmentDto.scheduledAt`. */
export class AvailabilityExceptionDto {
  @IsISO8601()
  from!: string;

  @IsISO8601()
  to!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class SetAvailabilityExceptionsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AvailabilityExceptionDto)
  exceptions!: AvailabilityExceptionDto[];
}
