import { Injectable, Inject, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { ClinicSubscription, PlanTier } from '@domain/subscription/clinic-subscription.entity';
import {
  ClinicSubscriptionRepository,
  CLINIC_SUBSCRIPTION_REPOSITORY,
} from '@domain-services/subscription/clinic-subscription.repository';
import { PaymentProvider, PAYMENT_PROVIDER } from '@domain-services/subscription/payment-provider';
import { getPlanBenefits } from '@domain-services/subscription/plan-benefits';
import { TherapistRepository, THERAPIST_REPOSITORY } from '@domain-services/platform/therapist.repository';
import { AuditService } from '@domain-services/platform/audit.service';

export interface AnexarCartaoInput {
  tenantId: string;
  holderName: string;
  number: string;
  expiryMonth: string;
  expiryYear: string;
  ccv: string;
  holderEmail: string;
  holderCpfCnpj: string;
  remoteIp: string;
}

/**
 * AnexarCartaoUseCase — passo 2 do checkout (só quando billingType=CREDIT_CARD).
 * O número do cartão passa por aqui em memória, na mesma requisição, e
 * segue direto para a Asaas via PaymentProvider — nunca é persistido em
 * nenhuma variável de longa duração, log, ou tabela do banco.
 */
@Injectable()
export class AnexarCartaoUseCase {
  constructor(
    @Inject(CLINIC_SUBSCRIPTION_REPOSITORY) private readonly repo: ClinicSubscriptionRepository,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
  ) {}

  async execute(input: AnexarCartaoInput): Promise<void> {
    const subscription = await this.repo.findByTenantId(input.tenantId);
    if (!subscription) throw new NotFoundException('Assinatura não encontrada.');
    if (!subscription.asaasSubscriptionId) {
      throw new BadRequestException('Assinatura ainda não foi vinculada à Asaas.');
    }

    await this.paymentProvider.attachCreditCard({
      asaasSubscriptionId: subscription.asaasSubscriptionId,
      holderName: input.holderName,
      number: input.number,
      expiryMonth: input.expiryMonth,
      expiryYear: input.expiryYear,
      ccv: input.ccv,
      holderEmail: input.holderEmail,
      holderCpfCnpj: input.holderCpfCnpj,
      remoteIp: input.remoteIp,
    });
  }
}

@Injectable()
export class ConsultarAssinaturaUseCase {
  constructor(@Inject(CLINIC_SUBSCRIPTION_REPOSITORY) private readonly repo: ClinicSubscriptionRepository) {}

  async execute(tenantId: string): Promise<ClinicSubscription> {
    const subscription = await this.repo.findByTenantId(tenantId);
    if (!subscription) throw new NotFoundException('Assinatura não encontrada.');
    return subscription;
  }
}

export interface UpgradeAssinaturaInput {
  tenantId: string;
  newPlan: PlanTier;
}

/**
 * UpgradeAssinaturaUseCase — CEO-DEC-002.5, CEO-DEC-003.6: aplicação
 * imediata, sem checagem de elegibilidade (subir de plano nunca esbarra em
 * teto de recurso).
 *
 * PENDÊNCIA REGISTRADA, NÃO IMPLEMENTADA: a cobrança prorateada da
 * diferença de valor, exigida pela mesma decisão, depende de
 * `currentPeriodEnd` — campo que existe no schema mas nunca é preenchido
 * em nenhum ponto do código (achado desta Sprint, Priority 4). Sem essa
 * data, não há como calcular "período restante do ciclo vigente" sem
 * inventar um valor. Este Use Case aplica a troca de plano; o ajuste de
 * cobrança na Asaas fica para quando essa lacuna for fechada.
 */
@Injectable()
export class UpgradeAssinaturaUseCase {
  constructor(
    @Inject(CLINIC_SUBSCRIPTION_REPOSITORY) private readonly repo: ClinicSubscriptionRepository,
    private readonly auditService: AuditService,
  ) {}

  async execute(input: UpgradeAssinaturaInput): Promise<ClinicSubscription> {
    const subscription = await this.repo.findByTenantId(input.tenantId);
    if (!subscription) throw new NotFoundException('Assinatura não encontrada.');

    subscription.changePlan(input.newPlan);
    await this.repo.save(subscription);
    await this.auditService.recordAll(subscription.pullDomainEvents());
    return subscription;
  }
}

export interface DowngradeAssinaturaInput {
  tenantId: string;
  newPlan: PlanTier;
}

/**
 * DowngradeAssinaturaUseCase — CEO-DEC-002.5, CEO-DEC-003.6: só elegível
 * se a clínica tiver terapeutas ativos dentro do teto do plano alvo —
 * mesma fonte de verdade que CadastrarTerapeutaUseCase
 * (PLAN_BENEFITS.maxTherapists). Nunca aplicado imediatamente: fica
 * agendado (`pendingPlan`) para o início do próximo ciclo de cobrança.
 *
 * `therapistRepo.findAllByTenant()` não recebe tenantId — depende do
 * TenantContext ambiente já estar no mesmo tenant de `input.tenantId`
 * (verdade em qualquer chamada real, vinda do Controller autenticado; não
 * verificado explicitamente aqui porque a interface do Repository não
 * expõe esse parâmetro).
 *
 * PENDÊNCIA REGISTRADA, NÃO IMPLEMENTADA: nenhum gatilho automático aplica
 * o downgrade agendado ainda — depende de tratar o evento de renovação de
 * ciclo da própria Asaas, que ProcessarWebhookAssinaturaUseCase não mapeia
 * hoje (mesma lacuna de `currentPeriodEnd` do Upgrade).
 * `ClinicSubscription.applyPendingDowngrade()` já existe, pronta para uso
 * quando esse gatilho for construído.
 */
@Injectable()
export class DowngradeAssinaturaUseCase {
  constructor(
    @Inject(CLINIC_SUBSCRIPTION_REPOSITORY) private readonly repo: ClinicSubscriptionRepository,
    @Inject(THERAPIST_REPOSITORY) private readonly therapistRepo: TherapistRepository,
    private readonly auditService: AuditService,
  ) {}

  async execute(input: DowngradeAssinaturaInput): Promise<ClinicSubscription> {
    const subscription = await this.repo.findByTenantId(input.tenantId);
    if (!subscription) throw new NotFoundException('Assinatura não encontrada.');

    // getPlanBenefits() (não indexação direta): downgrade para plano sem
    // benefícios configurados ('individual'/'completo', Priority 5) lança
    // erro em vez de assumir um teto — hoje inalcançável na prática.
    const maxTherapists = getPlanBenefits(input.newPlan).maxTherapists;
    if (maxTherapists !== null) {
      const activeTherapists = await this.therapistRepo.findAllByTenant();
      if (activeTherapists.length > maxTherapists) {
        throw new ConflictException({
          code: 'SUBSCRIPTION_DOWNGRADE_NOT_ELIGIBLE',
          message: `A clínica tem ${activeTherapists.length} terapeuta(s) — acima do limite de ${maxTherapists} do plano solicitado. Reduza o número de terapeutas antes de fazer downgrade.`,
          category: 'business_rule',
        });
      }
    }

    subscription.scheduleDowngrade(input.newPlan);
    await this.repo.save(subscription);
    await this.auditService.recordAll(subscription.pullDomainEvents());
    return subscription;
  }
}
