import { IsString, IsOptional, MinLength, IsIn, IsInt, Min, Validate, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { isIanaTimeZoneName } from '@domain/shared/time-zone';

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

@ValidatorConstraint({ name: 'isIanaTimeZoneName', async: false })
class IsIanaTimeZoneNameConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isIanaTimeZoneName(value);
  }

  defaultMessage(): string {
    return 'timeZone deve ser o nome de uma zona da base IANA, como "America/Sao_Paulo".';
  }
}

/** AD-039 (ADR-0064) — o fuso é obrigatório aqui: a rota não faz outra coisa. */
export class UpdateClinicTimeZoneDto {
  @IsString()
  @Validate(IsIanaTimeZoneNameConstraint)
  timeZone!: string;
}

export class UpdatePaymentInfoDto {
  @IsOptional()
  @IsString()
  pixKey?: string;

  @IsOptional()
  @IsString()
  payeeName?: string;
}
