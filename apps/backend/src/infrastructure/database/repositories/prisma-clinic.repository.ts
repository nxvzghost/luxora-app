import { Injectable } from '@nestjs/common';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { Clinic, BillingPolicy } from '@domain/clinic/clinic.entity';
import { ClinicRepository } from '@domain-services/platform/clinic.repository';

@Injectable()
export class PrismaClinicRepository implements ClinicRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByTenantId(tenantId: string): Promise<Clinic | null> {
    const [tenant, settings] = await this.prisma.forTenant(async (tx) => {
      const t = await tx.tenant.findUnique({ where: { id: tenantId } });
      const s = await tx.clinicSettings.findUnique({ where: { tenantId } });
      return [t, s] as const;
    });

    if (!tenant || !settings) return null;

    return Clinic.reconstitute({
      tenantId: tenant.id,
      name: tenant.name,
      defaultBillingPolicy: settings.defaultBillingPolicy as BillingPolicy,
      cancellationHoursLimit: settings.cancellationHoursLimit ?? undefined,
      defaultSessionDurationMinutes: settings.defaultSessionDurationMinutes,
      pixKey: settings.pixKey ?? undefined,
      payeeName: settings.payeeName ?? undefined,
    });
  }

  async save(clinic: Clinic): Promise<void> {
    await this.prisma.forTenant(async (tx) => {
      await tx.tenant.update({ where: { id: clinic.tenantId }, data: { name: clinic.name } });
      await tx.clinicSettings.update({
        where: { tenantId: clinic.tenantId },
        data: {
          defaultBillingPolicy: clinic.defaultBillingPolicy as never,
          cancellationHoursLimit: clinic.cancellationHoursLimit,
          defaultSessionDurationMinutes: clinic.defaultSessionDurationMinutes,
          pixKey: clinic.pixKey,
          payeeName: clinic.payeeName,
        },
      });
    });
  }
}
