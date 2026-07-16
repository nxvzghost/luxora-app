import { Injectable, Inject } from '@nestjs/common';
import { BillingRepository, BILLING_REPOSITORY } from '@domain-services/financial/billing.repository';

export interface FechamentoMensalPatientBreakdown {
  patientId: string;
  amount: number;
  status: 'em_atraso' | 'inadimplente' | 'pendente';
}

export interface FechamentoMensalResult {
  totalAppointmentsValue: number;
  received: number;
  pending: number;
  pendingPercentage: number;
  pendingByPatient: FechamentoMensalPatientBreakdown[];
  conclusion: string;
}

/**
 * GerarFechamentoMensalUseCase — Módulo 09/14.
 *
 * ESCOPO REDUZIDO, registrado sem disfarce: as 5 seções originais eram
 * (1) total e valor, (2) recebido/pendente, (3) detalhamento por paciente,
 * (4) comparação com mês anterior, (5) conclusão objetiva. Implementadas:
 * (1), (2), (3) e (5). A seção (4) exigiria agregação por período que
 * BillingRepository ainda não expõe — dívida registrada, não implementada.
 *
 * A conclusão (seção 5) é gerada por template determinístico a partir dos
 * números — nunca por IA, nunca especulativa.
 */
@Injectable()
export class GerarFechamentoMensalUseCase {
  constructor(@Inject(BILLING_REPOSITORY) private readonly repo: BillingRepository) {}

  async execute(): Promise<FechamentoMensalResult> {
    const allBillings = await this.repo.findAllByTenant({ limit: 1000 }); // TODO: paginação real se volume crescer

    const totalAppointmentsValue = allBillings.reduce((sum, b) => sum + b.amount, 0);
    const received = allBillings.filter((b) => b.state === 'Quitada').reduce((sum, b) => sum + b.amount, 0);
    const pendingBillings = allBillings.filter((b) => b.state !== 'Quitada' && b.state !== 'Cancelada');
    const pending = pendingBillings.reduce((sum, b) => sum + b.amount, 0);
    const pendingPercentage = totalAppointmentsValue > 0 ? (pending / totalAppointmentsValue) * 100 : 0;

    const pendingByPatient: FechamentoMensalPatientBreakdown[] = pendingBillings.map((b) => ({
      patientId: b.patientId,
      amount: b.amount,
      status: b.daysOverdue() > 40 ? 'inadimplente' : b.daysOverdue() > 0 ? 'em_atraso' : 'pendente',
    }));

    const conclusion = this.buildConclusion(totalAppointmentsValue, received, pending, pendingPercentage);

    return { totalAppointmentsValue, received, pending, pendingPercentage, pendingByPatient, conclusion };
  }

  private buildConclusion(total: number, received: number, pending: number, pendingPct: number): string {
    return `No período, o faturamento total foi de R$ ${total.toFixed(2)}, dos quais R$ ${received.toFixed(2)} já foram recebidos e R$ ${pending.toFixed(2)} permanecem pendentes (${pendingPct.toFixed(1)}% do total).`;
  }
}
