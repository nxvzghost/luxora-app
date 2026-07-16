import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { BillingController, PaymentController } from './billing.controller';
import {
  GerarCobrancaUseCase,
  ConsultarCobrancaUseCase,
  ListarCobrancasUseCase,
  EnviarCobrancaUseCase,
} from '@use-cases/billing/billing.use-cases';
import {
  RegistrarPagamentoUseCase,
  ConsultarPagamentoUseCase,
  EstornarPagamentoUseCase,
} from '@use-cases/payment/payment.use-cases';
import { BILLING_REPOSITORY } from '@domain-services/financial/billing.repository';
import { PAYMENT_REPOSITORY } from '@domain-services/financial/payment.repository';
import { PrismaBillingRepository } from '@infrastructure/database/repositories/prisma-billing.repository';
import { PrismaPaymentRepository } from '@infrastructure/database/repositories/prisma-payment.repository';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { AuditService } from '@domain-services/platform/audit.service';
import { AUDIT_LOG_REPOSITORY } from '@domain-services/platform/audit-log.repository';
import { PrismaAuditLogRepository } from '@infrastructure/database/repositories/prisma-audit-log.repository';
import { TenantContext } from '@shared/tenant-context';
import { PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { PrismaPatientRepository } from '@infrastructure/database/repositories/prisma-patient.repository';
import { CLINIC_REPOSITORY } from '@domain-services/platform/clinic.repository';
import { PrismaClinicRepository } from '@infrastructure/database/repositories/prisma-clinic.repository';
import { ConsultarSegmentacaoFinanceiraUseCase } from '@use-cases/billing/consultar-segmentacao-financeira.use-case';
import { ExecutarReguaInadimplenciaUseCase } from '@use-cases/billing/executar-regua-inadimplencia.use-case';
import { CommunicationModule } from '../communication/communication.module';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { CLINIC_SUBSCRIPTION_REPOSITORY } from '@domain-services/subscription/clinic-subscription.repository';
import { PrismaClinicSubscriptionRepository } from '@infrastructure/database/repositories/prisma-clinic-subscription.repository';

@Module({
  imports: [JwtModule.register({ secret: process.env.JWT_SECRET }), CommunicationModule],
  controllers: [BillingController, PaymentController],
  providers: [
    SubscriptionAccessGuard,
    { provide: CLINIC_SUBSCRIPTION_REPOSITORY, useClass: PrismaClinicSubscriptionRepository },
    GerarCobrancaUseCase,
    ConsultarCobrancaUseCase,
    ListarCobrancasUseCase,
    EnviarCobrancaUseCase,
    ConsultarSegmentacaoFinanceiraUseCase,
    ExecutarReguaInadimplenciaUseCase,
    RegistrarPagamentoUseCase,
    ConsultarPagamentoUseCase,
    EstornarPagamentoUseCase,
    { provide: BILLING_REPOSITORY, useClass: PrismaBillingRepository },
    { provide: PAYMENT_REPOSITORY, useClass: PrismaPaymentRepository },
    PrismaService,
    PrismaClientProvider,
    AuditService,
    { provide: AUDIT_LOG_REPOSITORY, useClass: PrismaAuditLogRepository },
    TenantContext,
    { provide: PATIENT_REPOSITORY, useClass: PrismaPatientRepository },
    { provide: CLINIC_REPOSITORY, useClass: PrismaClinicRepository },
    JwtAuthGuard,
  ],
})
export class BillingModule {}
