import { IsUUID } from 'class-validator';

export class LinkContactDto {
  @IsUUID()
  patientId!: string;
}
