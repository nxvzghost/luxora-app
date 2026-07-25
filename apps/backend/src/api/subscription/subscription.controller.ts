import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { SkipSubscriptionCheck } from './skip-subscription-check.decorator';
import { TenantContext } from '@shared/tenant-context';
import { CreateSubscriptionDto, AttachCreditCardDto, UpgradeSubscriptionDto, DowngradeSubscriptionDto } from './dto/subscription.dto';
import { CriarAssinaturaUseCase } from '@use-cases/subscription/criar-assinatura.use-case';
import {
  AnexarCartaoUseCase,
  ConsultarAssinaturaUseCase,
  UpgradeAssinaturaUseCase,
  DowngradeAssinaturaUseCase,
} from '@use-cases/subscription/gerenciar-assinatura.use-case';
import { GerarApiKeyUseCase } from '@use-cases/subscription/gerar-api-key.use-case';
import { ClinicSubscription } from '@domain/subscription/clinic-subscription.entity';

/**
 * SubscriptionController — Módulo 17. Checkout "modelo Netflix" (ADR-0037):
 * tudo dentro do próprio app, restrito a admin.
 *
 * @SkipSubscriptionCheck() no Controller inteiro — uma clínica com
 * assinatura PastDue/Cancelled PRECISA continuar acessando esta tela para
 * conseguir regularizar o pagamento. Se este Controller fosse bloqueado
 * pelo próprio gate que ele existe para satisfazer, ninguém conseguiria
 * sair do estado bloqueado.
 */
@ApiTags('subscription')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@SkipSubscriptionCheck()
@Controller('subscription')
export class SubscriptionController {
  constructor(
    private readonly criarAssinatura: CriarAssinaturaUseCase,
    private readonly anexarCartao: AnexarCartaoUseCase,
    private readonly consultarAssinatura: ConsultarAssinaturaUseCase,
    private readonly gerarApiKey: GerarApiKeyUseCase,
    private readonly upgradeAssinatura: UpgradeAssinaturaUseCase,
    private readonly downgradeAssinatura: DowngradeAssinaturaUseCase,
    private readonly tenantContext: TenantContext,
  ) {}

  @Get()
  @Roles('admin')
  async findOne() {
    return this.toResponse(await this.consultarAssinatura.execute(this.tenantContext.tenantId));
  }

  @Post()
  @Roles('admin')
  async create(@Body() dto: CreateSubscriptionDto) {
    const subscription = await this.criarAssinatura.execute({ ...dto, tenantId: this.tenantContext.tenantId });
    return this.toResponse(subscription);
  }

  @Post('credit-card')
  @Roles('admin')
  async attachCreditCard(@Body() dto: AttachCreditCardDto, @Req() req: Request) {
    await this.anexarCartao.execute({
      ...dto,
      tenantId: this.tenantContext.tenantId,
      remoteIp: req.ip ?? '0.0.0.0',
    });
    return { status: 'attached' };
  }

  @Post('api-key')
  @Roles('admin')
  async generateApiKey() {
    // Retorna o segredo em texto puro só nesta resposta — nunca mais
    // recuperável depois (ver GerarApiKeyUseCase).
    return this.gerarApiKey.execute();
  }

  /**
   * Upgrade (CEO-DEC-002.5, CEO-DEC-003.6) — aplicação imediata. Cobrança
   * prorateada da diferença NÃO é calculada (pendência já registrada no
   * Use Case) — Sprint 2 é integração, não regra de negócio nova.
   */
  @Post('upgrade')
  @ApiOperation({ summary: 'Upgrade de plano — aplicação imediata (CEO-DEC-003.6)' })
  @Roles('admin')
  async upgrade(@Body() dto: UpgradeSubscriptionDto) {
    const subscription = await this.upgradeAssinatura.execute({
      tenantId: this.tenantContext.tenantId,
      newPlan: dto.newPlan,
    });
    return this.toResponse(subscription);
  }

  /**
   * Downgrade (CEO-DEC-002.5, CEO-DEC-003.6) — agendado, sujeito a
   * elegibilidade de terapeutas ativos; entra em vigor apenas no próximo
   * ciclo de cobrança (ver `pendingPlan` na resposta).
   */
  @Post('downgrade')
  @ApiOperation({ summary: 'Downgrade de plano — agendado para o próximo ciclo, sujeito a elegibilidade (CEO-DEC-002.5)' })
  @Roles('admin')
  async downgrade(@Body() dto: DowngradeSubscriptionDto) {
    const subscription = await this.downgradeAssinatura.execute({
      tenantId: this.tenantContext.tenantId,
      newPlan: dto.newPlan,
    });
    return this.toResponse(subscription);
  }

  private toResponse(subscription: ClinicSubscription) {
    return {
      plan: subscription.plan,
      billingCycle: subscription.billingCycle,
      status: subscription.status,
      amountPerCycle: subscription.amountPerCycle,
      pendingPlan: subscription.pendingPlan ?? null,
    };
  }
}
