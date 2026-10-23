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
import {
  AbonarFaltaUseCase,
  ConfirmarCobrancaDeFaltaUseCase,
  RegistrarFaltaUseCase,
  RegistrarRealizacaoUseCase,
  ReverterAbonoUseCase,
} from '@use-cases/appointment/desfecho-consulta.use-case';
import { CriarAgendamentoRecorrenteUseCase } from '@use-cases/appointment/criar-agendamento-recorrente.use-case';
import { ListarAgendamentosUseCase } from '@use-cases/appointment/listar-agendamentos.use-case';
import { APPOINTMENT_OUTCOME_REPOSITORY } from '@domain-services/patient-ops/appointment-outcome.repository';
import { APPOINTMENT_NOTICE_REPOSITORY } from '@domain-services/patient-ops/appointment-notice.repository';
import { CLINIC_REPOSITORY } from '@domain-services/platform/clinic.repository';
import { UNIT_OF_WORK } from '@domain-services/platform/unit-of-work';
import { CLOCK } from '@domain-services/platform/clock';
import { PrismaAppointmentOutcomeRepository } from '@infrastructure/database/repositories/prisma-appointment-outcome.repository';
import { PrismaAppointmentNoticeRepository } from '@infrastructure/database/repositories/prisma-appointment-notice.repository';
import { PrismaClinicRepository } from '@infrastructure/database/repositories/prisma-clinic.repository';
import { PrismaUnitOfWork } from '@infrastructure/database/prisma-unit-of-work';
import { SystemClock } from '@infrastructure/clock/system-clock';
import { VerificarDisponibilidadeUseCase } from '@use-cases/availability/verificar-disponibilidade.use-case';
import { MaterializarRecurringBlockUseCase } from '@use-cases/availability/materializar-recurring-block.use-case';
import { CriarRecurringBlockUseCase, ListarRecurringBlocksUseCase } from '@use-cases/availability/gerenciar-recurring-block.use-case';
import { APPOINTMENT_REPOSITORY } from '@domain-services/patient-ops/appointment.repository';
import { SESSION_REPOSITORY } from '@domain-services/patient-ops/session.repository';
import { THERAPIST_REPOSITORY } from '@domain-services/platform/therapist.repository';
import { PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { PrismaPatientRepository } from '@infrastructure/database/repositories/prisma-patient.repository';
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
    // K2-b (ADR-0069) — desfechos e decisões sobre a falta.
    RegistrarRealizacaoUseCase,
    RegistrarFaltaUseCase,
    ConfirmarCobrancaDeFaltaUseCase,
    AbonarFaltaUseCase,
    ReverterAbonoUseCase,
    { provide: APPOINTMENT_OUTCOME_REPOSITORY, useClass: PrismaAppointmentOutcomeRepository },
    { provide: APPOINTMENT_NOTICE_REPOSITORY, useClass: PrismaAppointmentNoticeRepository },
    { provide: CLINIC_REPOSITORY, useClass: PrismaClinicRepository },
    { provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork },
    { provide: CLOCK, useClass: SystemClock },
    MaterializarRecurringBlockUseCase,
    CriarRecurringBlockUseCase,
    ListarRecurringBlocksUseCase,
    { provide: APPOINTMENT_REPOSITORY, useClass: PrismaAppointmentRepository },
    { provide: SESSION_REPOSITORY, useClass: PrismaSessionRepository },
    { provide: THERAPIST_REPOSITORY, useClass: PrismaTherapistRepository },
    { provide: PATIENT_REPOSITORY, useClass: PrismaPatientRepository },
    { provide: AVAILABILITY_REPOSITORY, useClass: PrismaAvailabilityRepository },
    { provide: CLINIC_HOLIDAY_REPOSITORY, useClass: PrismaClinicHolidayRepository },
    { provide: RECURRING_BLOCK_REPOSITORY, useClass: PrismaRecurringBlockRepository },
    PrismaService,
    AuditService,
    { provide: AUDIT_LOG_REPOSITORY, useClass: PrismaAuditLogRepository },
    JwtAuthGuard,
  ],
})
export class AppointmentsModule {}
