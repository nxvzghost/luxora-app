import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClinicHoliday } from '@domain/availability/clinic-holiday.entity';
import { CLINIC_HOLIDAY_REPOSITORY, ClinicHolidayRepository } from '@domain-services/availability/clinic-holiday.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { TenantContext } from '@shared/tenant-context';

/**
 * CriarFeriadoUseCase / RemoverFeriadoUseCase / ListarFeriadosUseCase —
 * PD-001 Fase 2, B5. Gerenciamento de `ClinicHoliday` — `tenantId` obtido
 * de `TenantContext` aqui, na camada de aplicação (permitido; a restrição
 * de nunca depender de contexto implícito é do Repository, não do Caso de
 * Uso — ver ClinicHolidayRepository).
 *
 * Auditoria (revisão pós-B5): Criar/Remover chamam `auditService.recordAll`
 * após persistir, mesmo padrão uniforme dos outros 14 Casos de Uso do
 * projeto que emitem auditoria. `ListarFeriadosUseCase` é consulta pura,
 * sem efeito colateral — não gera evento, mesma regra dos demais Casos de
 * Uso somente-leitura do projeto (nenhum deles chama `recordAll`).
 */

export interface CriarFeriadoInput {
  from: Date;
  to: Date;
  reason?: string;
}

@Injectable()
export class CriarFeriadoUseCase {
  constructor(
    @Inject(CLINIC_HOLIDAY_REPOSITORY) private readonly repo: ClinicHolidayRepository,
    private readonly tenantContext: TenantContext,
    private readonly auditService: AuditService,
  ) {}

  async execute(input: CriarFeriadoInput): Promise<ClinicHoliday> {
    const holiday = ClinicHoliday.create({
      id: randomUUID(),
      tenantId: this.tenantContext.tenantId,
      from: input.from,
      to: input.to,
      reason: input.reason,
    });
    holiday.markCreated();
    await this.repo.save(holiday);
    await this.auditService.recordAll(holiday.pullDomainEvents());
    return holiday;
  }
}

/**
 * RemoverFeriadoUseCase — fluxo obrigatório (PD-001 Fase 2, B5): localizar
 * antes de remover, nunca `delete()` direto só pelo `id`. Garante que um
 * `id` de outro Tenant nunca é removido, e que o cliente recebe o mesmo
 * NotFoundException tanto para "não existe" quanto para "existe, mas é de
 * outro Tenant" — nunca vaza qual dos dois é o caso.
 */
@Injectable()
export class RemoverFeriadoUseCase {
  constructor(
    @Inject(CLINIC_HOLIDAY_REPOSITORY) private readonly repo: ClinicHolidayRepository,
    private readonly tenantContext: TenantContext,
    private readonly auditService: AuditService,
  ) {}

  async execute(id: string): Promise<void> {
    const holiday = await this.repo.findById(this.tenantContext.tenantId, id);
    if (!holiday) {
      throw new NotFoundException('Feriado não encontrado.');
    }
    holiday.markRemoved();
    await this.repo.delete(this.tenantContext.tenantId, id);
    await this.auditService.recordAll(holiday.pullDomainEvents());
  }
}

@Injectable()
export class ListarFeriadosUseCase {
  constructor(
    @Inject(CLINIC_HOLIDAY_REPOSITORY) private readonly repo: ClinicHolidayRepository,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(from: Date, to: Date): Promise<ClinicHoliday[]> {
    return this.repo.findByTenantAndRange(this.tenantContext.tenantId, from, to);
  }
}
