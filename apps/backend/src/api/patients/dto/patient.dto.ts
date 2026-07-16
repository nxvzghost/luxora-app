import { IsString, IsOptional, MinLength, IsIn } from 'class-validator';

export class CreatePatientDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsString()
  @MinLength(8)
  phone!: string;
}

export class UpdatePatientDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  phone?: string;

  @IsOptional()
  @IsIn(['per_session', 'weekly', 'monthly', null])
  billingPolicyOverride?: 'per_session' | 'weekly' | 'monthly' | null;
}
