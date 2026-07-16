import { Module } from '@nestjs/common';
import { ProcessarMensagemUseCase } from '@use-cases/ai/processar-mensagem.use-case';
import { IntentActionRouter } from '@use-cases/ai/intent-action-router';
import { AI_PROVIDER } from '@domain-services/ai/ai-provider';
import { AnthropicAIProvider } from '@infrastructure/ai/anthropic-ai.provider';
import { AgendarConsultaUseCase } from '@use-cases/appointment/agendar-consulta.use-case';
import { CancelarConsultaUseCase, ConfirmarConsultaUseCase } from '@use-cases/appointment/gerenciar-consulta.use-case';
import { ConsultarCobrancaUseCase } from '@use-cases/billing/billing.use-cases';
import { APPOINTMENT_REPOSITORY } from '@domain-services/patient-ops/appointment.repository';
import { SESSION_REPOSITORY } from '@domain-services/patient-ops/session.repository';
import { BILLING_REPOSITORY } from '@domain-services/financial/billing.repository';
import { CLINIC_REPOSITORY } from '@domain-services/platform/clinic.repository';
import { THERAPIST_REPOSITORY } from '@domain-services/platform/therapist.repository';
import { PrismaAppointmentRepository } from '@infrastructure/database/repositories/prisma-appointment.repository';
import { PrismaSessionRepository } from '@infrastructure/database/repositories/prisma-session.repository';
import { PrismaBillingRepository } from '@infrastructure/database/repositories/prisma-billing.repository';
import { PrismaClinicRepository } from '@infrastructure/database/repositories/prisma-clinic.repository';
import { PrismaTherapistRepository } from '@infrastructure/database/repositories/prisma-therapist.repository';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { CommunicationModule } from '../communication/communication.module';
import { AuditModule } from '../audit/audit.module';

/**
 * AIModule — Módulo 12, revisão geral: IntentActionRouter conectado,
 * fechando o ADR-0033. Sem Controller próprio ainda — o ponto de entrada
 * real (webhook do WhatsApp recebendo mensagem do paciente) continua como
 * dívida explícita (ver README).
 */
@Module({
  imports: [CommunicationModule, AuditModule],
  providers: [
    ProcessarMensagemUseCase,
    IntentActionRouter,
    AgendarConsultaUseCase,
    CancelarConsultaUseCase,
    ConfirmarConsultaUseCase,
    ConsultarCobrancaUseCase,
    { provide: AI_PROVIDER, useClass: AnthropicAIProvider },
    { provide: APPOINTMENT_REPOSITORY, useClass: PrismaAppointmentRepository },
    { provide: SESSION_REPOSITORY, useClass: PrismaSessionRepository },
    { provide: BILLING_REPOSITORY, useClass: PrismaBillingRepository },
    { provide: CLINIC_REPOSITORY, useClass: PrismaClinicRepository },
    { provide: THERAPIST_REPOSITORY, useClass: PrismaTherapistRepository },
    PrismaService,
    PrismaClientProvider,
  ],
  exports: [ProcessarMensagemUseCase],
})
export class AIModule {}
