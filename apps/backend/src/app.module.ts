import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './api/health.controller';
import { MetricsController } from './api/metrics/metrics.controller';
import { MetricsAccessGuard } from './api/metrics/metrics-access.guard';
import { TenantContextModule } from '@shared/tenant-context.module';
import { CorrelationContextModule } from '@shared/correlation-context.module';
import { AuthModule } from './api/auth/auth.module';
import { PatientsModule } from './api/patients/patients.module';
import { TherapistsModule } from './api/therapists/therapists.module';
import { ClinicModule } from './api/clinic/clinic.module';
import { AppointmentsModule } from './api/appointments/appointments.module';
import { BillingModule } from './api/billing/billing.module';
import { AuditModule } from './api/audit/audit.module';
import { CommunicationModule } from './api/communication/communication.module';
import { AIModule } from './api/ai/ai.module';
import { AutomationsModule } from './api/automations/automations.module';
import { SubscriptionModule } from './api/subscription/subscription.module';
import { UsersModule } from './api/users/users.module';

/**
 * AppModule — módulo raiz.
 *
 * Módulo 9 (Financeiro) adiciona BillingModule. Módulo 7 (Agenda) adiciona AppointmentsModule. API Layer formal entra no
 * Módulo 8, conforme LUXORA/03 - ENGINEERING/00 - Roadmap/roadmap.md.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    TenantContextModule,
    CorrelationContextModule,
    AuthModule,
    PatientsModule,
    TherapistsModule,
    ClinicModule,
    AppointmentsModule,
    BillingModule,
    AuditModule,
    CommunicationModule,
    AIModule,
    AutomationsModule,
    SubscriptionModule,
    UsersModule,
  ],
  controllers: [HealthController, MetricsController],
  providers: [MetricsAccessGuard],
})
export class AppModule {}
