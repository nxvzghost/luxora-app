import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AvailabilityCalendar,
  AvailabilityException,
  AvailabilityWindow,
} from '@domain/availability/availability-calendar.entity';
import { AVAILABILITY_REPOSITORY, AvailabilityRepository } from '@domain-services/availability/availability.repository';
import { THERAPIST_REPOSITORY, TherapistRepository } from '@domain-services/platform/therapist.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { TenantContext } from '@shared/tenant-context';

/**
 * ConsultarCalendarioUseCase / DefinirDisponibilidadeUseCase — migrados de
 * `use-cases/therapist/` para o Bounded Context `Availability` (ADR-0040,
 * PD-001): definir/consultar disponibilidade não é mais responsabilidade do
 * contexto de Terapeuta, é responsabilidade do Motor de Disponibilidade.
 */
@Injectable()
export class ConsultarCalendarioUseCase {
  constructor(@Inject(AVAILABILITY_REPOSITORY) private readonly repo: AvailabilityRepository) {}

  async execute(therapistId: string): Promise<AvailabilityCalendar> {
    const calendar = await this.repo.findByTherapistId(therapistId);
    if (!calendar) {
      throw new NotFoundException('Calendário de disponibilidade não encontrado para este terapeuta.');
    }
    return calendar;
  }
}

@Injectable()
export class DefinirDisponibilidadeUseCase {
  constructor(
    @Inject(AVAILABILITY_REPOSITORY) private readonly repo: AvailabilityRepository,
    @Inject(THERAPIST_REPOSITORY) private readonly therapistRepo: TherapistRepository,
    private readonly tenantContext: TenantContext,
    private readonly auditService: AuditService,
  ) {}

  async execute(therapistId: string, windows: AvailabilityWindow[]): Promise<AvailabilityCalendar> {
    const therapist = await this.therapistRepo.findById(therapistId);
    if (!therapist) {
      throw new NotFoundException('Terapeuta não encontrado.');
    }

    let calendar = await this.repo.findByTherapistId(therapistId);
    if (!calendar) {
      calendar = AvailabilityCalendar.create({
        id: randomUUID(),
        tenantId: this.tenantContext.tenantId,
        therapistId,
      });
    }

    calendar.setWindows(windows);
    await this.repo.save(calendar);
    await this.auditService.recordAll(calendar.pullDomainEvents());
    return calendar;
  }
}

/**
 * DefinirExcecoesDisponibilidadeUseCase — AD-008 (Epic 7, PD-001 Fase 2 B1).
 * Mesmo shape de DefinirDisponibilidadeUseCase (find-or-create, delega a
 * validação inteira à entidade via setExceptions(), salva, audita) — a
 * mesma UX de "substitui a lista inteira, nunca faz merge parcial" já usada
 * para janelas.
 */
@Injectable()
export class DefinirExcecoesDisponibilidadeUseCase {
  constructor(
    @Inject(AVAILABILITY_REPOSITORY) private readonly repo: AvailabilityRepository,
    @Inject(THERAPIST_REPOSITORY) private readonly therapistRepo: TherapistRepository,
    private readonly tenantContext: TenantContext,
    private readonly auditService: AuditService,
  ) {}

  async execute(therapistId: string, exceptions: AvailabilityException[]): Promise<AvailabilityCalendar> {
    const therapist = await this.therapistRepo.findById(therapistId);
    if (!therapist) {
      throw new NotFoundException('Terapeuta não encontrado.');
    }

    let calendar = await this.repo.findByTherapistId(therapistId);
    if (!calendar) {
      calendar = AvailabilityCalendar.create({
        id: randomUUID(),
        tenantId: this.tenantContext.tenantId,
        therapistId,
      });
    }

    calendar.setExceptions(exceptions);
    await this.repo.save(calendar);
    await this.auditService.recordAll(calendar.pullDomainEvents());
    return calendar;
  }
}
