import { Injectable, Inject } from '@nestjs/common';
import { Clinic, BillingPolicy } from '@domain/clinic/clinic.entity';
import { ClinicRepository, CLINIC_REPOSITORY } from '@domain-services/platform/clinic.repository';
import { ClinicNotFoundError } from '@domain-services/platform/clinic-not-found.error';
import { AuditService } from '@domain-services/platform/audit.service';
import { UnitOfWork, UNIT_OF_WORK } from '@domain-services/platform/unit-of-work';
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
 * AlterarFusoClinicaUseCase — AD-039 (ADR-0064). O fuso decide em que hora a
 * agenda abre e em que dia uma cobrança vence: a troca e o seu registro de
 * auditoria são gravados na mesma transação — ou os dois, ou nenhum.
 *
 * A clínica é lida dentro dela, com a configuração travada: o "fuso
 * anterior" do registro é o que estava gravado no momento da troca, mesmo
 * que dois administradores troquem ao mesmo tempo. Só o fuso é gravado.
 *
 * Pedir o fuso que a clínica já tem não grava nem audita nada.
 */
@Injectable()
export class AlterarFusoClinicaUseCase {
  constructor(
    @Inject(CLINIC_REPOSITORY) private readonly repo: ClinicRepository,
    private readonly tenantContext: TenantContext,
    private readonly auditService: AuditService,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(input: { timeZone: string }): Promise<Clinic> {
    return this.unitOfWork.run(async () => {
      const clinic = await this.repo.findByTenantIdForUpdate(this.tenantContext.tenantId);
      if (!clinic) {
        throw new ClinicNotFoundError();
      }
      if (clinic.changeTimeZone(input.timeZone)) {
        await this.repo.saveTimeZone(clinic);
        await this.auditService.recordAll(clinic.pullDomainEvents());
      }
      return clinic;
    });
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
