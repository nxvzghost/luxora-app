import { Injectable, Inject } from '@nestjs/common';
import { BillingRepository, BILLING_REPOSITORY } from '@domain-services/financial/billing.repository';

export type FinancialSegment = 'em_atraso' | 'inadimplente';

export interface SegmentedBilling {
  billingId: string;
  patientId: string;
  amount: number;
  daysOverdue: number;
  segment: FinancialSegment;
}

/**
 * ConsultarSegmentacaoFinanceiraUseCase — Módulo 13.
 * Fonte: 02 - CTO/clinicos/docs/05-IA/03-Gestao-de-Inadimplencia.md.
 *
 * Limiares confirmados pela liderança: em_atraso até 7 dias (inclusive);
 * inadimplente acima de 40 dias. Entre 8 e 40, ainda em_atraso.
 */
@Injectable()
export class ConsultarSegmentacaoFinanceiraUseCase {
  constructor(@Inject(BILLING_REPOSITORY) private readonly repo: BillingRepository) {}

  async execute(): Promise<SegmentedBilling[]> {
    const overdue = await this.repo.findOverdueByTenant();
    return overdue.map((billing) => {
      const daysOverdue = billing.daysOverdue();
      return {
        billingId: billing.id,
        patientId: billing.patientId,
        amount: billing.amount,
        daysOverdue,
        segment: this.classify(daysOverdue),
      };
    });
  }

  private classify(daysOverdue: number): FinancialSegment {
    return daysOverdue > 40 ? 'inadimplente' : 'em_atraso';
  }
}
