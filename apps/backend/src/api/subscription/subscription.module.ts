import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SubscriptionController } from './subscription.controller';
import { WebhookController } from './webhook.controller';
import { AsaasWebhookGuard } from './asaas-webhook.guard';
import { CriarAssinaturaUseCase } from '@use-cases/subscription/criar-assinatura.use-case';
import { AnexarCartaoUseCase, ConsultarAssinaturaUseCase } from '@use-cases/subscription/gerenciar-assinatura.use-case';
import { ProcessarWebhookAssinaturaUseCase } from '@use-cases/subscription/processar-webhook-assinatura.use-case';
import { CLINIC_SUBSCRIPTION_REPOSITORY } from '@domain-services/subscription/clinic-subscription.repository';
import { WEBHOOK_EVENT_REPOSITORY } from '@domain-services/subscription/webhook-event.repository';
import { PAYMENT_PROVIDER } from '@domain-services/subscription/payment-provider';
import { PrismaClinicSubscriptionRepository } from '@infrastructure/database/repositories/prisma-clinic-subscription.repository';
import { PrismaWebhookEventRepository } from '@infrastructure/database/repositories/prisma-webhook-event.repository';
import { AsaasPaymentProvider } from '@infrastructure/payment/asaas-payment.provider';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [JwtModule.register({ secret: process.env.JWT_SECRET }), AuditModule],
  controllers: [SubscriptionController, WebhookController],
  providers: [
    CriarAssinaturaUseCase,
    AnexarCartaoUseCase,
    ConsultarAssinaturaUseCase,
    ProcessarWebhookAssinaturaUseCase,
    { provide: CLINIC_SUBSCRIPTION_REPOSITORY, useClass: PrismaClinicSubscriptionRepository },
    { provide: WEBHOOK_EVENT_REPOSITORY, useClass: PrismaWebhookEventRepository },
    { provide: PAYMENT_PROVIDER, useClass: AsaasPaymentProvider },
    PrismaService,
    PrismaClientProvider,
    JwtAuthGuard,
    RolesGuard,
    AsaasWebhookGuard,
  ],
})
export class SubscriptionModule {}
