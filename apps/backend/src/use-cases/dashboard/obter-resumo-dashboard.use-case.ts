import { Injectable, Inject } from '@nestjs/common';
import { PatientRepository, PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { BillingRepository, BILLING_REPOSITORY } from '@domain-services/financial/billing.repository';
import { CLINIC_TIME_ZONE_READER, ClinicTimeZoneReader } from '@domain-services/platform/clinic-time-zone.reader';

export interface ResumoDashboard {
  activePatients: number;
  overdueBillings: number;
  totalPending: number;
}

/** Epic 11 — agrega os 3 indicadores de GET /dashboard/summary diretamente no banco. */
@Injectable()
export class ObterResumoDashboardUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY) private readonly patientRepository: PatientRepository,
    @Inject(BILLING_REPOSITORY) private readonly billingRepository: BillingRepository,
    @Inject(CLINIC_TIME_ZONE_READER) private readonly clinicTimeZone: ClinicTimeZoneReader,
  ) {}

  async execute(): Promise<ResumoDashboard> {
    // AD-039 — "em atraso" é contado pelo dia do calendário da clínica.
    const timeZone = await this.clinicTimeZone.current();
    const [activePatients, overdueBillings, totalPending] = await Promise.all([
      this.patientRepository.countActiveByTenant(),
      this.billingRepository.countOverdueByTenant(timeZone),
      this.billingRepository.sumPendingByTenant(),
    ]);
    return { activePatients, overdueBillings, totalPending };
  }
}
