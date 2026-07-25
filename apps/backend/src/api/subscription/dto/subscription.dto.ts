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

/**
 * `individual`/`completo` propositalmente FORA da lista — Priority 5
 * (PD-003) os deixou apenas como estrutura, sem preço nem benefício
 * configurado (`PLAN_BENEFITS`/`MONTHLY_PRICE_BRL` parciais). Permitir
 * upgrade/downgrade para eles agora deixaria a assinatura num estado sem
 * `amountPerCycle` nem `maxTherapists` funcionando — validação de entrada,
 * não regra de negócio nova.
 */
const OPERATIONAL_PLANS = ['professional', 'business', 'enterprise'] as const;

export class UpgradeSubscriptionDto {
  @IsIn(OPERATIONAL_PLANS)
  newPlan!: 'professional' | 'business' | 'enterprise';
}

export class DowngradeSubscriptionDto {
  @IsIn(OPERATIONAL_PLANS)
  newPlan!: 'professional' | 'business' | 'enterprise';
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
