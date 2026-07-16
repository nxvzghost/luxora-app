import { Module } from '@nestjs/common';
import { AutomationsController } from './automations.controller';
import { AutomationApiKeyGuard } from './automation-api-key.guard';
import { EnviarResumoAgendaDoDiaUseCase } from '@use-cases/scheduling/enviar-resumo-agenda-do-dia.use-case';
import { ReenviarAgendaAtualizadaUseCase } from '@use-cases/scheduling/reenviar-agenda-atualizada.use-case';
import { ExecutarReguaInadimplenciaUseCase } from '@use-cases/billing/executar-regua-inadimplencia.use-case';
import { ConsultarSegmentacaoFinanceiraUseCase } from '@use-cases/billing/consultar-segmentacao-financeira.use-case';
import { GerarFechamentoMensalUseCase } from '@use-cases/billing/gerar-fechamento-mensal.use-case';
import { APPOINTMENT_REPOSITORY } from '@domain-services/patient-ops/appointment.repository';
import { THERAPIST_REPOSITORY } from '@domain-services/platform/therapist.repository';
import { PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { BILLING_REPOSITORY } from '@domain-services/financial/billing.repository';
import { PrismaAppointmentRepository } from '@infrastructure/database/repositories/prisma-appointment.repository';
import { PrismaTherapistRepository } from '@infrastructure/database/repositories/prisma-therapist.repository';
import { PrismaPatientRepository } from '@infrastructure/database/repositories/prisma-patient.repository';
import { PrismaBillingRepository } from '@infrastructure/database/repositories/prisma-billing.repository';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { TenantContext } from '@shared/tenant-context';
import { CommunicationModule } from '../communication/communication.module';

@Module({
  imports: [CommunicationModule],
  controllers: [AutomationsController],
  providers: [
    AutomationApiKeyGuard,
    EnviarResumoAgendaDoDiaUseCase,
    ReenviarAgendaAtualizadaUseCase,
    ExecutarReguaInadimplenciaUseCase,
    ConsultarSegmentacaoFinanceiraUseCase,
    GerarFechamentoMensalUseCase,
    { provide: APPOINTMENT_REPOSITORY, useClass: PrismaAppointmentRepository },
    { provide: THERAPIST_REPOSITORY, useClass: PrismaTherapistRepository },
    { provide: PATIENT_REPOSITORY, useClass: PrismaPatientRepository },
    { provide: BILLING_REPOSITORY, useClass: PrismaBillingRepository },
    PrismaService,
    PrismaClientProvider,
    TenantContext,
  ],
})
export class AutomationsModule {}
