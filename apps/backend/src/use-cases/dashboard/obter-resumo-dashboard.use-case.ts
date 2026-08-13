import { Injectable, Inject } from '@nestjs/common';
import { PatientRepository, PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { BillingRepository, BILLING_REPOSITORY } from '@domain-services/financial/billing.repository';

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
  ) {}

  async execute(): Promise<ResumoDashboard> {
    const [activePatients, overdueBillings, totalPending] = await Promise.all([
      this.patientRepository.countActiveByTenant(),
      this.billingRepository.countOverdueByTenant(),
      this.billingRepository.sumPendingByTenant(),
    ]);
    return { activePatients, overdueBillings, totalPending };
  }
}
