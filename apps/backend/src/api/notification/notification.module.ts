import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { NotificationController } from './notification.controller';
import {
  ListarNotificacoesUseCase,
  ContarNotificacoesNaoLidasUseCase,
  MarcarNotificacaoComoLidaUseCase,
} from '@use-cases/notification/notification.use-cases';
import { NOTIFICATION_REPOSITORY } from '@domain-services/platform/notification.repository';
import { PrismaNotificationRepository } from '@infrastructure/database/repositories/prisma-notification.repository';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { CLINIC_SUBSCRIPTION_REPOSITORY } from '@domain-services/subscription/clinic-subscription.repository';
import { PrismaClinicSubscriptionRepository } from '@infrastructure/database/repositories/prisma-clinic-subscription.repository';

/**
 * NotificationModule — Epic 12 (AD-021). Auto-suficiente, mesmo padrão de
 * AuditModule/DashboardModule: re-provê NOTIFICATION_REPOSITORY (já provido
 * também em BillingModule, para o fluxo de escrita síncrono do pagamento) —
 * módulos Nest não compartilham DI entre si sem import/export explícito.
 */
@Module({
  imports: [JwtModule.register({ secret: process.env.JWT_SECRET })],
  controllers: [NotificationController],
  providers: [
    ListarNotificacoesUseCase,
    ContarNotificacoesNaoLidasUseCase,
    MarcarNotificacaoComoLidaUseCase,
    { provide: NOTIFICATION_REPOSITORY, useClass: PrismaNotificationRepository },
    PrismaService,
    PrismaClientProvider,
    SubscriptionAccessGuard,
    { provide: CLINIC_SUBSCRIPTION_REPOSITORY, useClass: PrismaClinicSubscriptionRepository },
    JwtAuthGuard,
    RolesGuard,
  ],
})
export class NotificationModule {}
