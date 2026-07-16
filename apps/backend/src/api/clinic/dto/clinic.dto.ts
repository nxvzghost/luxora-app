import { IsString, IsOptional, MinLength, IsIn, IsInt, Min } from 'class-validator';

export class UpdateClinicDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;
}

export class UpdateClinicPoliciesDto {
  @IsOptional()
  @IsIn(['per_session', 'weekly', 'monthly'])
  defaultBillingPolicy?: 'per_session' | 'weekly' | 'monthly';

  @IsOptional()
  @IsInt()
  @Min(0)
  cancellationHoursLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  defaultSessionDurationMinutes?: number;
}

export class UpdatePaymentInfoDto {
  @IsOptional()
  @IsString()
  pixKey?: string;

  @IsOptional()
  @IsString()
  payeeName?: string;
}
