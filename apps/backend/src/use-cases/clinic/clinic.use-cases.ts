import { Injectable, Inject } from '@nestjs/common';
import { Clinic, BillingPolicy } from '@domain/clinic/clinic.entity';
import { ClinicRepository, CLINIC_REPOSITORY } from '@domain-services/platform/clinic.repository';
import { ClinicNotFoundError } from '@domain-services/platform/clinic-not-found.error';
import { AuditService } from '@domain-services/platform/audit.service';
import { TenantContext } from '@shared/tenant-context';

@Injectable()
export class ConsultarClinicaUseCase {
  constructor(
    @Inject(CLINIC_REPOSITORY) private readonly repo: ClinicRepository,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(): Promise<Clinic> {
    const clinic = await this.repo.findByTenantId(this.tenantContext.tenantId);
    if (!clinic) {
      throw new ClinicNotFoundError();
    }
    return clinic;
  }
}

@Injectable()
export class AtualizarClinicaUseCase {
  constructor(
    @Inject(CLINIC_REPOSITORY) private readonly repo: ClinicRepository,
    private readonly consultarClinica: ConsultarClinicaUseCase,
    private readonly auditService: AuditService,
  ) {}

  async execute(input: { name?: string }): Promise<Clinic> {
    const clinic = await this.consultarClinica.execute();
    if (input.name) {
      clinic.rename(input.name);
    }
    await this.repo.save(clinic);
    await this.auditService.recordAll(clinic.pullDomainEvents());
    return clinic;
  }
}

@Injectable()
export class AtualizarPoliticasClinicaUseCase {
  constructor(
    @Inject(CLINIC_REPOSITORY) private readonly repo: ClinicRepository,
    private readonly consultarClinica: ConsultarClinicaUseCase,
    private readonly auditService: AuditService,
  ) {}

  async execute(input: {
    defaultBillingPolicy?: BillingPolicy;
    cancellationHoursLimit?: number;
    defaultSessionDurationMinutes?: number;
  }): Promise<Clinic> {
    const clinic = await this.consultarClinica.execute();
    clinic.updatePolicies(input);
    await this.repo.save(clinic);
    await this.auditService.recordAll(clinic.pullDomainEvents());
    return clinic;
  }
}

/**
 * AtualizarDadosPagamentoUseCase — fecha a dívida acumulada desde o
 * Módulo 11: antes, pixKey/payeeName só podiam ser inseridos direto no
 * banco (seed/admin manual), sem endpoint nenhum.
 */
@Injectable()
export class AtualizarDadosPagamentoUseCase {
  constructor(
    @Inject(CLINIC_REPOSITORY) private readonly repo: ClinicRepository,
    private readonly consultarClinica: ConsultarClinicaUseCase,
    private readonly auditService: AuditService,
  ) {}

  async execute(input: { pixKey?: string; payeeName?: string }): Promise<Clinic> {
    const clinic = await this.consultarClinica.execute();
    clinic.updatePaymentInfo(input);
    await this.repo.save(clinic);
    await this.auditService.recordAll(clinic.pullDomainEvents());
    return clinic;
  }
}
