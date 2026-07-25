import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppointmentsController } from './appointments.controller';
import { RecurringBlocksController } from '../recurring-blocks/recurring-blocks.controller';
import { ConsultarDisponibilidadeUseCase } from '@use-cases/appointment/consultar-disponibilidade.use-case';
import { AgendarConsultaUseCase } from '@use-cases/appointment/agendar-consulta.use-case';
import {
  RemarcarConsultaUseCase,
  CancelarConsultaUseCase,
  ConfirmarConsultaUseCase,
} from '@use-cases/appointment/gerenciar-consulta.use-case';
import { CriarAgendamentoRecorrenteUseCase } from '@use-cases/appointment/criar-agendamento-recorrente.use-case';
import { ListarAgendamentosUseCase } from '@use-cases/appointment/listar-agendamentos.use-case';
import { VerificarDisponibilidadeUseCase } from '@use-cases/availability/verificar-disponibilidade.use-case';
import { MaterializarRecurringBlockUseCase } from '@use-cases/availability/materializar-recurring-block.use-case';
import { CriarRecurringBlockUseCase, ListarRecurringBlocksUseCase } from '@use-cases/availability/gerenciar-recurring-block.use-case';
import { APPOINTMENT_REPOSITORY } from '@domain-services/patient-ops/appointment.repository';
import { SESSION_REPOSITORY } from '@domain-services/patient-ops/session.repository';
import { THERAPIST_REPOSITORY } from '@domain-services/platform/therapist.repository';
import { AVAILABILITY_REPOSITORY } from '@domain-services/availability/availability.repository';
import { CLINIC_HOLIDAY_REPOSITORY } from '@domain-services/availability/clinic-holiday.repository';
import { RECURRING_BLOCK_REPOSITORY } from '@domain-services/availability/recurring-block.repository';
import { PrismaAppointmentRepository } from '@infrastructure/database/repositories/prisma-appointment.repository';
import { PrismaSessionRepository } from '@infrastructure/database/repositories/prisma-session.repository';
import { PrismaTherapistRepository } from '@infrastructure/database/repositories/prisma-therapist.repository';
import { PrismaAvailabilityRepository } from '@infrastructure/database/repositories/prisma-availability.repository';
import { PrismaClinicHolidayRepository } from '@infrastructure/database/repositories/prisma-clinic-holiday.repository';
import { PrismaRecurringBlockRepository } from '@infrastructure/database/repositories/prisma-recurring-block.repository';
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
  controllers: [AppointmentsController, RecurringBlocksController],
  providers: [
    SubscriptionAccessGuard,
    { provide: CLINIC_SUBSCRIPTION_REPOSITORY, useClass: PrismaClinicSubscriptionRepository },
    ConsultarDisponibilidadeUseCase,
    VerificarDisponibilidadeUseCase,
    AgendarConsultaUseCase,
    RemarcarConsultaUseCase,
    CancelarConsultaUseCase,
    ConfirmarConsultaUseCase,
    CriarAgendamentoRecorrenteUseCase,
    ListarAgendamentosUseCase,
    MaterializarRecurringBlockUseCase,
    CriarRecurringBlockUseCase,
    ListarRecurringBlocksUseCase,
    { provide: APPOINTMENT_REPOSITORY, useClass: PrismaAppointmentRepository },
    { provide: SESSION_REPOSITORY, useClass: PrismaSessionRepository },
    { provide: THERAPIST_REPOSITORY, useClass: PrismaTherapistRepository },
    { provide: AVAILABILITY_REPOSITORY, useClass: PrismaAvailabilityRepository },
    { provide: CLINIC_HOLIDAY_REPOSITORY, useClass: PrismaClinicHolidayRepository },
    { provide: RECURRING_BLOCK_REPOSITORY, useClass: PrismaRecurringBlockRepository },
    PrismaService,
    PrismaClientProvider,
    AuditService,
    { provide: AUDIT_LOG_REPOSITORY, useClass: PrismaAuditLogRepository },
    JwtAuthGuard,
  ],
})
export class AppointmentsModule {}
