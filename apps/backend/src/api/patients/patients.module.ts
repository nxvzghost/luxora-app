import { Module } from '@nestjs/common';
import { PatientsController } from './patients.controller';
import { CadastrarPacienteUseCase } from '@use-cases/patient/cadastrar-paciente.use-case';
import { ConsultarPacienteUseCase } from '@use-cases/patient/consultar-paciente.use-case';
import { ListarPacientesUseCase } from '@use-cases/patient/listar-pacientes.use-case';
import { AtualizarPacienteUseCase } from '@use-cases/patient/atualizar-paciente.use-case';
import {
  InativarPacienteUseCase,
  ReativarPacienteUseCase,
  DarAltaPacienteUseCase,
} from '@use-cases/patient/gerenciar-status-paciente.use-case';
import { PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { PrismaPatientRepository } from '@infrastructure/database/repositories/prisma-patient.repository';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { AuditService } from '@domain-services/platform/audit.service';
import { AUDIT_LOG_REPOSITORY } from '@domain-services/platform/audit-log.repository';
import { PrismaAuditLogRepository } from '@infrastructure/database/repositories/prisma-audit-log.repository';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JwtModule } from '@nestjs/jwt';

import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { CLINIC_SUBSCRIPTION_REPOSITORY } from '@domain-services/subscription/clinic-subscription.repository';
import { PrismaClinicSubscriptionRepository } from '@infrastructure/database/repositories/prisma-clinic-subscription.repository';

@Module({
  imports: [JwtModule.register({ secret: process.env.JWT_SECRET })],
  controllers: [PatientsController],
  providers: [
    SubscriptionAccessGuard,
    { provide: CLINIC_SUBSCRIPTION_REPOSITORY, useClass: PrismaClinicSubscriptionRepository },
    CadastrarPacienteUseCase,
    ConsultarPacienteUseCase,
    ListarPacientesUseCase,
    AtualizarPacienteUseCase,
    InativarPacienteUseCase,
    ReativarPacienteUseCase,
    DarAltaPacienteUseCase,
    { provide: PATIENT_REPOSITORY, useClass: PrismaPatientRepository },
    PrismaService,
    PrismaClientProvider,
    AuditService,
    { provide: AUDIT_LOG_REPOSITORY, useClass: PrismaAuditLogRepository },
    JwtAuthGuard,
  ],
})
export class PatientsModule {}
