import { IsString, IsOptional, MinLength, IsArray, ValidateNested, Min, Max, Matches } from 'class-validator';
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

export class AvailabilitySlotDto {
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/)
  startTime!: string;

  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/)
  endTime!: string;
}

export class SetAvailabilityDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AvailabilitySlotDto)
  slots!: AvailabilitySlotDto[];
}
