import { Injectable, Inject, NotFoundException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Therapist } from '@domain/therapist/therapist.entity';
import { TherapistRepository, THERAPIST_REPOSITORY } from '@domain-services/platform/therapist.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import {
  ClinicSubscriptionRepository,
  CLINIC_SUBSCRIPTION_REPOSITORY,
} from '@domain-services/subscription/clinic-subscription.repository';
import { getPlanBenefits } from '@domain-services/subscription/plan-benefits';
import { TenantContext } from '@shared/tenant-context';

@Injectable()
export class CadastrarTerapeutaUseCase {
  constructor(
    @Inject(THERAPIST_REPOSITORY) private readonly repo: TherapistRepository,
    @Inject(CLINIC_SUBSCRIPTION_REPOSITORY) private readonly subscriptionRepo: ClinicSubscriptionRepository,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(input: { name: string; specialty?: string; phone?: string }): Promise<Therapist> {
    await this.assertWithinPlanLimit();

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

  /**
   * Limite por plano (Módulo 17) — fonte única de verdade em
   * PLAN_BENEFITS.maxTherapists. Assinatura ausente nunca deveria chegar
   * aqui (SubscriptionAccessGuard já bloqueia antes), mas trata como "sem
   * limite" em vez de lançar, para não acoplar esta regra de negócio ao
   * comportamento do guard.
   */
  private async assertWithinPlanLimit(): Promise<void> {
    const subscription = await this.subscriptionRepo.findByTenantId(this.tenantContext.tenantId);
    // getPlanBenefits() (não indexação direta): plano sem benefícios
    // configurados ('individual'/'completo', Priority 5) lança erro em vez
    // de silenciosamente virar "sem limite" — hoje inalcançável na prática,
    // já que nenhuma assinatura consegue ser criada com esses planos ainda
    // (amountPerCycle bloqueia primeiro).
    const maxTherapists = subscription ? getPlanBenefits(subscription.plan).maxTherapists : null;
    if (maxTherapists === null) return;

    const existing = await this.repo.findAllByTenant();
    if (existing.length >= maxTherapists) {
      throw new ConflictException({
        code: 'THERAPIST_LIMIT_REACHED',
        message: `O plano atual permite no máximo ${maxTherapists} terapeuta(s). Faça upgrade para cadastrar mais.`,
        category: 'business_rule',
      });
    }
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
