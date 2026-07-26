import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TherapistsController } from './therapists.controller';
import {
  CadastrarTerapeutaUseCase,
  ConsultarTerapeutaUseCase,
  ListarTerapeutasUseCase,
  AtualizarTerapeutaUseCase,
} from '@use-cases/therapist/therapist.use-cases';
import {
  DefinirDisponibilidadeUseCase,
  DefinirExcecoesDisponibilidadeUseCase,
} from '@use-cases/availability/gerenciar-disponibilidade.use-case';
import { THERAPIST_REPOSITORY } from '@domain-services/platform/therapist.repository';
import { AVAILABILITY_REPOSITORY } from '@domain-services/availability/availability.repository';
import { PrismaTherapistRepository } from '@infrastructure/database/repositories/prisma-therapist.repository';
import { PrismaAvailabilityRepository } from '@infrastructure/database/repositories/prisma-availability.repository';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { AuditService } from '@domain-services/platform/audit.service';
import { AUDIT_LOG_REPOSITORY } from '@domain-services/platform/audit-log.repository';
import { PrismaAuditLogRepository } from '@infrastructure/database/repositories/prisma-audit-log.repository';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { CLINIC_SUBSCRIPTION_REPOSITORY } from '@domain-services/subscription/clinic-subscription.repository';
import { PrismaClinicSubscriptionRepository } from '@infrastructure/database/repositories/prisma-clinic-subscription.repository';

@Module({
  imports: [JwtModule.register({ secret: process.env.JWT_SECRET })],
  controllers: [TherapistsController],
  providers: [
    SubscriptionAccessGuard,
    { provide: CLINIC_SUBSCRIPTION_REPOSITORY, useClass: PrismaClinicSubscriptionRepository },
    CadastrarTerapeutaUseCase,
    ConsultarTerapeutaUseCase,
    ListarTerapeutasUseCase,
    AtualizarTerapeutaUseCase,
    DefinirDisponibilidadeUseCase,
    DefinirExcecoesDisponibilidadeUseCase,
    { provide: THERAPIST_REPOSITORY, useClass: PrismaTherapistRepository },
    { provide: AVAILABILITY_REPOSITORY, useClass: PrismaAvailabilityRepository },
    PrismaService,
    PrismaClientProvider,
    AuditService,
    { provide: AUDIT_LOG_REPOSITORY, useClass: PrismaAuditLogRepository },
    JwtAuthGuard,
  ],
})
export class TherapistsModule {}
