import { Module } from '@nestjs/common';
import { EnviarMensagemUseCase } from '@use-cases/communication/enviar-mensagem.use-case';
import { ConectarWhatsAppUseCase } from '@use-cases/communication/conectar-whatsapp.use-case';
import { ReceberMensagemWhatsAppUseCase } from '@use-cases/communication/receber-mensagem-whatsapp.use-case';
import { MESSAGE_PROVIDER } from '@domain-services/communication/message-provider';
import { MESSAGE_LOG_REPOSITORY } from '@domain-services/communication/message-log.repository';
import { CONVERSATION_REPOSITORY } from '@domain-services/communication/conversation.repository';
import { WhatsAppMessageProvider } from '@infrastructure/messaging/whatsapp-message.provider';
import { PrismaMessageLogRepository } from '@infrastructure/database/repositories/prisma-message-log.repository';
import { PrismaConversationRepository } from '@infrastructure/database/repositories/prisma-conversation.repository';
import { MessageQueueProducer } from '@infrastructure/messaging/message-queue.producer';
import { MessageQueueWorker } from '@infrastructure/messaging/message-queue.worker';
import { WhatsAppInboundQueueProducer } from '@infrastructure/messaging/whatsapp-inbound-queue.producer';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { TokenCipherService } from '@shared/token-cipher.service';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';
import { WhatsAppWebhookGuard } from './whatsapp-webhook.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { JwtModule } from '@nestjs/jwt';
import { PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { PrismaPatientRepository } from '@infrastructure/database/repositories/prisma-patient.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { AUDIT_LOG_REPOSITORY } from '@domain-services/platform/audit-log.repository';
import { PrismaAuditLogRepository } from '@infrastructure/database/repositories/prisma-audit-log.repository';

/**
 * CommunicationModule — Módulo 11, com correção de isolamento (ver
 * ADR referente à conexão de WhatsApp por clínica).
 */
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { CLINIC_SUBSCRIPTION_REPOSITORY } from '@domain-services/subscription/clinic-subscription.repository';
import { PrismaClinicSubscriptionRepository } from '@infrastructure/database/repositories/prisma-clinic-subscription.repository';
import { ContactModule } from '../patient-ops/contact.module';

/**
 * ADR-0055 (AD-018), Fase 5 — importa ContactModule para que
 * ReceberMensagemWhatsAppUseCase (abaixo) possa injetar
 * ReconhecerOuCriarContatoUseCase — único ponto de entrada de
 * reconhecimento/criação de Contact. Só o Use Case é consumido aqui;
 * ContactRepository/PhoneNumber nunca aparecem neste módulo, exportados
 * mas não usados.
 */
@Module({
  imports: [JwtModule.register({ secret: process.env.JWT_SECRET }), ContactModule],
  controllers: [WhatsAppController, WhatsAppWebhookController],
  providers: [
    SubscriptionAccessGuard,
    { provide: CLINIC_SUBSCRIPTION_REPOSITORY, useClass: PrismaClinicSubscriptionRepository },
    EnviarMensagemUseCase,
    ConectarWhatsAppUseCase,
    ReceberMensagemWhatsAppUseCase,
    WhatsAppWebhookGuard,
    { provide: MESSAGE_PROVIDER, useClass: WhatsAppMessageProvider },
    { provide: MESSAGE_LOG_REPOSITORY, useClass: PrismaMessageLogRepository },
    { provide: CONVERSATION_REPOSITORY, useClass: PrismaConversationRepository },
    { provide: PATIENT_REPOSITORY, useClass: PrismaPatientRepository },
    { provide: AUDIT_LOG_REPOSITORY, useClass: PrismaAuditLogRepository },
    AuditService,
    MessageQueueProducer,
    MessageQueueWorker,
    WhatsAppInboundQueueProducer,
    PrismaService,
    PrismaClientProvider,
    TokenCipherService,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [MessageQueueProducer, CONVERSATION_REPOSITORY],
})
export class CommunicationModule {}
