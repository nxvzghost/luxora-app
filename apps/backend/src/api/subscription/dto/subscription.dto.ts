import { IsString, IsIn, IsEmail, MinLength } from 'class-validator';

export class CreateSubscriptionDto {
  @IsIn(['professional', 'business', 'enterprise'])
  plan!: 'professional' | 'business' | 'enterprise';

  @IsIn(['monthly', 'yearly'])
  billingCycle!: 'monthly' | 'yearly';

  @IsString()
  @MinLength(2)
  clinicName!: string;

  @IsEmail()
  clinicEmail!: string;

  @IsString()
  clinicCpfCnpj!: string;

  @IsIn(['CREDIT_CARD', 'PIX'])
  billingType!: 'CREDIT_CARD' | 'PIX';
}

export class AttachCreditCardDto {
  @IsString()
  holderName!: string;

  @IsString()
  number!: string;

  @IsString()
  expiryMonth!: string;

  @IsString()
  expiryYear!: string;

  @IsString()
  ccv!: string;

  @IsEmail()
  holderEmail!: string;

  @IsString()
  holderCpfCnpj!: string;
}
