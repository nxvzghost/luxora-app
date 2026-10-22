import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ClinicController } from './clinic.controller';
import {
  ConsultarClinicaUseCase,
  AtualizarClinicaUseCase,
  AtualizarPoliticasClinicaUseCase,
  AtualizarDadosPagamentoUseCase,
  AlterarFusoClinicaUseCase,
} from '@use-cases/clinic/clinic.use-cases';
import { UNIT_OF_WORK } from '@domain-services/platform/unit-of-work';
import { PrismaUnitOfWork } from '@infrastructure/database/prisma-unit-of-work';
import { CLINIC_REPOSITORY } from '@domain-services/platform/clinic.repository';
import { PrismaClinicRepository } from '@infrastructure/database/repositories/prisma-clinic.repository';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { AuditService } from '@domain-services/platform/audit.service';
import { AUDIT_LOG_REPOSITORY } from '@domain-services/platform/audit-log.repository';
import { PrismaAuditLogRepository } from '@infrastructure/database/repositories/prisma-audit-log.repository';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { CLINIC_SUBSCRIPTION_REPOSITORY } from '@domain-services/subscription/clinic-subscription.repository';
import { PrismaClinicSubscriptionRepository } from '@infrastructure/database/repositories/prisma-clinic-subscription.repository';

@Module({
  imports: [JwtModule.register({ secret: process.env.JWT_SECRET })],
  controllers: [ClinicController],
  providers: [
    SubscriptionAccessGuard,
    { provide: CLINIC_SUBSCRIPTION_REPOSITORY, useClass: PrismaClinicSubscriptionRepository },
    ConsultarClinicaUseCase,
    AtualizarClinicaUseCase,
    AtualizarPoliticasClinicaUseCase,
    AtualizarDadosPagamentoUseCase,
    AlterarFusoClinicaUseCase,
    { provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork },
    { provide: CLINIC_REPOSITORY, useClass: PrismaClinicRepository },
    PrismaService,
    AuditService,
    { provide: AUDIT_LOG_REPOSITORY, useClass: PrismaAuditLogRepository },
    JwtAuthGuard,
  ],
})
export class ClinicModule {}
