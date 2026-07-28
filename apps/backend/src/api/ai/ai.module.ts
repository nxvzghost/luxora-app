import { Module } from '@nestjs/common';
import { ProcessarMensagemUseCase } from '@use-cases/ai/processar-mensagem.use-case';
import { IntentActionRouter } from '@use-cases/ai/intent-action-router';
import { AI_PROVIDER } from '@domain-services/ai/ai-provider';
import { AnthropicAIProvider } from '@infrastructure/ai/anthropic-ai.provider';
import { AgendarConsultaUseCase } from '@use-cases/appointment/agendar-consulta.use-case';
import {
  CancelarConsultaUseCase,
  ConfirmarConsultaUseCase,
  RemarcarConsultaUseCase,
} from '@use-cases/appointment/gerenciar-consulta.use-case';
import { ConsultarCobrancaUseCase } from '@use-cases/billing/billing.use-cases';
import { VerificarDisponibilidadeUseCase } from '@use-cases/availability/verificar-disponibilidade.use-case';
import { ConsultarDisponibilidadeUseCase } from '@use-cases/appointment/consultar-disponibilidade.use-case';
import { ProcessarMensagemWhatsAppUseCase } from '@use-cases/communication/processar-mensagem-whatsapp.use-case';
import { APPOINTMENT_REPOSITORY } from '@domain-services/patient-ops/appointment.repository';
import { SESSION_REPOSITORY } from '@domain-services/patient-ops/session.repository';
import { BILLING_REPOSITORY } from '@domain-services/financial/billing.repository';
import { CLINIC_REPOSITORY } from '@domain-services/platform/clinic.repository';
import { THERAPIST_REPOSITORY } from '@domain-services/platform/therapist.repository';
import { AVAILABILITY_REPOSITORY } from '@domain-services/availability/availability.repository';
import { CLINIC_HOLIDAY_REPOSITORY } from '@domain-services/availability/clinic-holiday.repository';
import { PrismaAppointmentRepository } from '@infrastructure/database/repositories/prisma-appointment.repository';
import { PrismaSessionRepository } from '@infrastructure/database/repositories/prisma-session.repository';
import { PrismaBillingRepository } from '@infrastructure/database/repositories/prisma-billing.repository';
import { PrismaClinicRepository } from '@infrastructure/database/repositories/prisma-clinic.repository';
import { PrismaTherapistRepository } from '@infrastructure/database/repositories/prisma-therapist.repository';
import { PrismaAvailabilityRepository } from '@infrastructure/database/repositories/prisma-availability.repository';
import { PrismaClinicHolidayRepository } from '@infrastructure/database/repositories/prisma-clinic-holiday.repository';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { WhatsAppInboundQueueWorker } from '@infrastructure/messaging/whatsapp-inbound-queue.worker';
import { CommunicationModule } from '../communication/communication.module';
import { AuditModule } from '../audit/audit.module';

/**
 * AIModule — Módulo 12. ADR-0053 (AD-007/AD-010): ponto de entrada real
 * (webhook do WhatsApp) implementado em CommunicationModule
 * (WhatsAppWebhookController) — este módulo ganha a parte assíncrona
 * (ProcessarMensagemWhatsAppUseCase + WhatsAppInboundQueueWorker, que
 * dependem de ProcessarMensagemUseCase, já daqui) e os 2 intents novos de
 * AD-010 (RemarcarConsultaUseCase, ConsultarDisponibilidadeUseCase — já
 * existiam prontos em AppointmentsModule, só não conectados aqui).
 */
@Module({
  imports: [CommunicationModule, AuditModule],
  providers: [
    ProcessarMensagemUseCase,
    IntentActionRouter,
    AgendarConsultaUseCase,
    CancelarConsultaUseCase,
    ConfirmarConsultaUseCase,
    RemarcarConsultaUseCase,
    ConsultarCobrancaUseCase,
    VerificarDisponibilidadeUseCase,
    ConsultarDisponibilidadeUseCase,
    ProcessarMensagemWhatsAppUseCase,
    WhatsAppInboundQueueWorker,
    { provide: AI_PROVIDER, useClass: AnthropicAIProvider },
    { provide: APPOINTMENT_REPOSITORY, useClass: PrismaAppointmentRepository },
    { provide: SESSION_REPOSITORY, useClass: PrismaSessionRepository },
    { provide: BILLING_REPOSITORY, useClass: PrismaBillingRepository },
    { provide: CLINIC_REPOSITORY, useClass: PrismaClinicRepository },
    { provide: THERAPIST_REPOSITORY, useClass: PrismaTherapistRepository },
    { provide: AVAILABILITY_REPOSITORY, useClass: PrismaAvailabilityRepository },
    { provide: CLINIC_HOLIDAY_REPOSITORY, useClass: PrismaClinicHolidayRepository },
    PrismaService,
    PrismaClientProvider,
  ],
  exports: [ProcessarMensagemUseCase],
})
export class AIModule {}
