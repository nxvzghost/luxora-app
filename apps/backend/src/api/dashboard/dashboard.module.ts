import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DashboardController } from './dashboard.controller';
import { ObterResumoDashboardUseCase } from '@use-cases/dashboard/obter-resumo-dashboard.use-case';
import { PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { PrismaPatientRepository } from '@infrastructure/database/repositories/prisma-patient.repository';
import { BILLING_REPOSITORY } from '@domain-services/financial/billing.repository';
import { PrismaBillingRepository } from '@infrastructure/database/repositories/prisma-billing.repository';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { CLINIC_SUBSCRIPTION_REPOSITORY } from '@domain-services/subscription/clinic-subscription.repository';
import { PrismaClinicSubscriptionRepository } from '@infrastructure/database/repositories/prisma-clinic-subscription.repository';

/**
 * DashboardModule — Epic 11. Autossuficiente: nem PatientsModule nem
 * BillingModule exportam seus repositórios, então este módulo re-provê as
 * próprias ligações (mesmo padrão já usado por BillingModule para
 * PATIENT_REPOSITORY). Somente leitura/agregação — sem AuditService, sem
 * BullMQ, sem CommunicationModule.
 */
@Module({
  imports: [JwtModule.register({ secret: process.env.JWT_SECRET })],
  controllers: [DashboardController],
  providers: [
    ObterResumoDashboardUseCase,
    { provide: PATIENT_REPOSITORY, useClass: PrismaPatientRepository },
    { provide: BILLING_REPOSITORY, useClass: PrismaBillingRepository },
    PrismaService,
    PrismaClientProvider,
    SubscriptionAccessGuard,
    { provide: CLINIC_SUBSCRIPTION_REPOSITORY, useClass: PrismaClinicSubscriptionRepository },
    JwtAuthGuard,
  ],
})
export class DashboardModule {}
