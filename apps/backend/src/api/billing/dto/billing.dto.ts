import { IsString, IsNumber, IsDateString, IsArray, ArrayMinSize, Min, IsPositive } from 'class-validator';

export class CreateBillingDto {
  @IsString()
  patientId!: string;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsDateString()
  dueDate!: string;

  @IsArray()
  @ArrayMinSize(1)
  sessionIds!: string[];
}

export class CreatePaymentDto {
  @IsString()
  billingId!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;
}
