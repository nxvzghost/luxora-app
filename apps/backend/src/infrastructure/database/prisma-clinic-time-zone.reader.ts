import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { ClinicTimeZoneReader } from '@domain-services/platform/clinic-time-zone.reader';
import { assertTimeZone, DEFAULT_CLINIC_TIME_ZONE } from '@domain/shared/time-zone';

/**
 * Lê o fuso da clínica dentro de uma transação já aberta para ela
 * (`PrismaService.forTenant`): a RLS de `clinic_settings` deixa visível só a
 * linha da clínica da requisição. Usado também pelos repositórios que montam
 * um agregado que depende do fuso, na mesma transação da leitura principal.
 */
export async function readClinicTimeZone(tx: Pick<PrismaClient, 'clinicSettings'>): Promise<string> {
  const settings = await tx.clinicSettings.findFirst({ select: { timeZone: true } });
  return settings ? assertTimeZone(settings.timeZone) : DEFAULT_CLINIC_TIME_ZONE;
}

@Injectable()
export class PrismaClinicTimeZoneReader implements ClinicTimeZoneReader {
  constructor(private readonly prisma: PrismaService) {}

  current(): Promise<string> {
    return this.prisma.forTenant((tx) => readClinicTimeZone(tx));
  }
}
