import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { SkipSubscriptionCheck } from './skip-subscription-check.decorator';
import { TenantContext } from '@shared/tenant-context';
import { CreateSubscriptionDto, AttachCreditCardDto } from './dto/subscription.dto';
import { CriarAssinaturaUseCase } from '@use-cases/subscription/criar-assinatura.use-case';
import { AnexarCartaoUseCase, ConsultarAssinaturaUseCase } from '@use-cases/subscription/gerenciar-assinatura.use-case';
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

  private toResponse(subscription: ClinicSubscription) {
    return {
      plan: subscription.plan,
      billingCycle: subscription.billingCycle,
      status: subscription.status,
      amountPerCycle: subscription.amountPerCycle,
    };
  }
}
