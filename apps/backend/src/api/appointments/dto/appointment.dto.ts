import { IsString, IsDateString, IsIn, IsOptional, IsBoolean, IsInt, Min, MaxLength } from 'class-validator';
import { NOTICE_REASON_MAX_LENGTH, NOTICE_REQUESTERS, NoticeRequestedBy } from '@domain/appointment/appointment-notice';

/**
 * K2-b (ADR-0069, seção 7; DP-25) — quem pediu o cancelamento ou a
 * remarcação, registrado à parte de quem registrou. Obrigatório: não é
 * presumido. O motivo é opcional, livre, até 200 caracteres, e fica fora da
 * auditoria e da IA.
 */
export class NoticeBodyDto {
  @IsIn(NOTICE_REQUESTERS)
  requestedBy!: NoticeRequestedBy;

  @IsOptional()
  @IsString()
  @MaxLength(NOTICE_REASON_MAX_LENGTH)
  reason?: string;
}

export class CancelAppointmentDto extends NoticeBodyDto {}

/** Abono e reversão do abono (DP-23, DP-24a): o motivo é obrigatório — conferido no domínio (REASON_REQUIRED). */
export class DecisionReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(NOTICE_REASON_MAX_LENGTH)
  reason?: string;
}

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

export class RescheduleAppointmentDto extends NoticeBodyDto {
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
