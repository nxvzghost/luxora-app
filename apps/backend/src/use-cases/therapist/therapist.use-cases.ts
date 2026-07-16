import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Therapist, WeeklyAvailabilitySlot } from '@domain/therapist/therapist.entity';
import { TherapistRepository, THERAPIST_REPOSITORY } from '@domain-services/platform/therapist.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { TenantContext } from '@shared/tenant-context';

@Injectable()
export class CadastrarTerapeutaUseCase {
  constructor(
    @Inject(THERAPIST_REPOSITORY) private readonly repo: TherapistRepository,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(input: { name: string; specialty?: string; phone?: string }): Promise<Therapist> {
    const therapist = Therapist.create({
      id: randomUUID(),
      tenantId: this.tenantContext.tenantId,
      name: input.name,
      specialty: input.specialty,
      phone: input.phone,
    });
    await this.repo.save(therapist);
    return therapist;
  }
}

@Injectable()
export class ConsultarTerapeutaUseCase {
  constructor(@Inject(THERAPIST_REPOSITORY) private readonly repo: TherapistRepository) {}

  async execute(id: string): Promise<Therapist> {
    const therapist = await this.repo.findById(id);
    if (!therapist) {
      throw new NotFoundException('Terapeuta não encontrado.');
    }
    return therapist;
  }
}

@Injectable()
export class ListarTerapeutasUseCase {
  constructor(@Inject(THERAPIST_REPOSITORY) private readonly repo: TherapistRepository) {}

  async execute(): Promise<Therapist[]> {
    return this.repo.findAllByTenant();
  }
}

@Injectable()
export class AtualizarTerapeutaUseCase {
  constructor(
    @Inject(THERAPIST_REPOSITORY) private readonly repo: TherapistRepository,
    private readonly consultarTerapeuta: ConsultarTerapeutaUseCase,
    private readonly auditService: AuditService,
  ) {}

  async execute(input: { id: string; name?: string }): Promise<Therapist> {
    const therapist = await this.consultarTerapeuta.execute(input.id);
    if (input.name) {
      therapist.rename(input.name);
    }
    await this.repo.save(therapist);
    await this.auditService.recordAll(therapist.pullDomainEvents());
    return therapist;
  }
}

@Injectable()
export class DefinirDisponibilidadeUseCase {
  constructor(
    @Inject(THERAPIST_REPOSITORY) private readonly repo: TherapistRepository,
    private readonly consultarTerapeuta: ConsultarTerapeutaUseCase,
    private readonly auditService: AuditService,
  ) {}

  async execute(id: string, slots: WeeklyAvailabilitySlot[]): Promise<Therapist> {
    const therapist = await this.consultarTerapeuta.execute(id);
    therapist.setAvailability(slots);
    await this.repo.save(therapist);
    await this.auditService.recordAll(therapist.pullDomainEvents());
    return therapist;
  }
}
