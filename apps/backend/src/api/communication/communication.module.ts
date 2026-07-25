import { Module } from '@nestjs/common';
import { EnviarMensagemUseCase } from '@use-cases/communication/enviar-mensagem.use-case';
import { ConectarWhatsAppUseCase } from '@use-cases/communication/conectar-whatsapp.use-case';
import { MESSAGE_PROVIDER } from '@domain-services/communication/message-provider';
import { MESSAGE_LOG_REPOSITORY } from '@domain-services/communication/message-log.repository';
import { WhatsAppMessageProvider } from '@infrastructure/messaging/whatsapp-message.provider';
import { PrismaMessageLogRepository } from '@infrastructure/database/repositories/prisma-message-log.repository';
import { MessageQueueProducer } from '@infrastructure/messaging/message-queue.producer';
import { MessageQueueWorker } from '@infrastructure/messaging/message-queue.worker';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { TokenCipherService } from '@shared/token-cipher.service';
import { WhatsAppController } from './whatsapp.controller';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { JwtModule } from '@nestjs/jwt';

/**
 * CommunicationModule — Módulo 11, com correção de isolamento (ver
 * ADR referente à conexão de WhatsApp por clínica).
 */
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { CLINIC_SUBSCRIPTION_REPOSITORY } from '@domain-services/subscription/clinic-subscription.repository';
import { PrismaClinicSubscriptionRepository } from '@infrastructure/database/repositories/prisma-clinic-subscription.repository';

@Module({
  imports: [JwtModule.register({ secret: process.env.JWT_SECRET })],
  controllers: [WhatsAppController],
  providers: [
    SubscriptionAccessGuard,
    { provide: CLINIC_SUBSCRIPTION_REPOSITORY, useClass: PrismaClinicSubscriptionRepository },
    EnviarMensagemUseCase,
    ConectarWhatsAppUseCase,
    { provide: MESSAGE_PROVIDER, useClass: WhatsAppMessageProvider },
    { provide: MESSAGE_LOG_REPOSITORY, useClass: PrismaMessageLogRepository },
    MessageQueueProducer,
    MessageQueueWorker,
    PrismaService,
    PrismaClientProvider,
    TokenCipherService,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [MessageQueueProducer],
})
export class CommunicationModule {}
