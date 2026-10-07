import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ListarSessoesUseCase } from '@use-cases/session/listar-sessoes.use-case';
import { ListarPagamentosDaCobrancaUseCase } from '@use-cases/payment/payment.use-cases';
import type { SessionRepository, SessionSummary } from '@domain-services/patient-ops/session.repository';
import type { PaymentRepository } from '@domain-services/financial/payment.repository';
import type { BillingRepository } from '@domain-services/financial/billing.repository';
import { Payment } from '@domain/payment/payment.entity';

/**
 * Tarefa 05 da auditoria — casos de uso de leitura que o painel passou a usar.
 */

const SUMMARY: SessionSummary = {
  id: 'session-1',
  appointmentId: 'appointment-1',
  patientId: 'patient-1',
  therapistId: 'therapist-1',
  state: 'Realizada',
  scheduledAt: new Date('2026-10-12T14:00:00.000Z'),
};

describe('ListarSessoesUseCase', () => {
  it('repassa o filtro ao repositório e devolve o que ele encontrou', async () => {
    const findSummaries = vi.fn().mockResolvedValue([SUMMARY]);
    const useCase = new ListarSessoesUseCase({ findSummaries } as unknown as SessionRepository);

    const result = await useCase.execute({ state: 'Realizada', patientId: 'patient-1', limit: 50 });

    expect(result).toEqual([SUMMARY]);
    expect(findSummaries).toHaveBeenCalledWith({ state: 'Realizada', patientId: 'patient-1', limit: 50 });
  });

  it('sem filtro, lista tudo o que a clínica tem', async () => {
    const findSummaries = vi.fn().mockResolvedValue([]);

    await new ListarSessoesUseCase({ findSummaries } as unknown as SessionRepository).execute();

    expect(findSummaries).toHaveBeenCalledWith({});
  });
});

describe('ListarPagamentosDaCobrancaUseCase', () => {
  const payment = Payment.reconstitute({
    id: 'payment-1',
    tenantId: 'tenant-1',
    billingId: 'billing-1',
    amount: 250,
    method: 'pix',
    idempotencyKey: 'key-1',
    state: 'Confirmado',
  });

  function setup(options: { billingExists: boolean; payment: Payment | null }) {
    const findByBillingId = vi.fn().mockResolvedValue(options.payment);
    const findById = vi.fn().mockResolvedValue(options.billingExists ? { id: 'billing-1' } : null);
    const useCase = new ListarPagamentosDaCobrancaUseCase(
      { findByBillingId } as unknown as PaymentRepository,
      { findById } as unknown as BillingRepository,
    );
    return { useCase, findByBillingId };
  }

  it('devolve o pagamento da cobrança', async () => {
    const { useCase } = setup({ billingExists: true, payment });

    expect(await useCase.execute('billing-1')).toEqual([payment]);
  });

  it('cobrança ainda sem pagamento: lista vazia, não erro', async () => {
    const { useCase } = setup({ billingExists: true, payment: null });

    expect(await useCase.execute('billing-1')).toEqual([]);
  });

  it('cobrança inexistente (ou de outra clínica, invisível pela RLS): 404, sem consultar pagamento', async () => {
    const { useCase, findByBillingId } = setup({ billingExists: false, payment });

    await expect(useCase.execute('billing-x')).rejects.toBeInstanceOf(NotFoundException);
    expect(findByBillingId).not.toHaveBeenCalled();
  });
});
