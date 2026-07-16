import { describe, it, expect, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { CriarAssinaturaUseCase } from '@use-cases/subscription/criar-assinatura.use-case';
import { ClinicSubscription } from '@domain/subscription/clinic-subscription.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function makeUseCase(existing: ClinicSubscription | null = null) {
  const repo = { findByTenantId: vi.fn().mockResolvedValue(existing), findByAsaasSubscriptionId: vi.fn(), save: vi.fn().mockResolvedValue(undefined) };
  const paymentProvider = {
    createCustomer: vi.fn().mockResolvedValue({ asaasCustomerId: 'cus_123' }),
    createSubscription: vi.fn().mockResolvedValue({ asaasSubscriptionId: 'sub_456' }),
    attachCreditCard: vi.fn(),
    cancelSubscription: vi.fn(),
  };
  const auditService = { recordAll: vi.fn().mockResolvedValue(undefined) } as never;
  return { useCase: new CriarAssinaturaUseCase(repo, paymentProvider, auditService), repo, paymentProvider };
}

describe('CriarAssinaturaUseCase', () => {
  it('cria cliente e assinatura na Asaas, salva o vínculo local', async () => {
    const { useCase, repo, paymentProvider } = makeUseCase();
    const subscription = await useCase.execute({
      tenantId: TENANT_ID,
      plan: 'professional',
      billingCycle: 'monthly',
      clinicName: 'Clínica Teste',
      clinicEmail: 'contato@clinica.com',
      clinicCpfCnpj: '12345678901',
      billingType: 'CREDIT_CARD',
    });

    expect(paymentProvider.createCustomer).toHaveBeenCalledOnce();
    expect(paymentProvider.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ asaasCustomerId: 'cus_123', value: 597, cycle: 'MONTHLY' }),
    );
    expect(subscription.asaasSubscriptionId).toBe('sub_456');
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it('rejeita nova assinatura se já existe uma ativa/trial para o Tenant', async () => {
    const existing = ClinicSubscription.reconstitute({
      id: 's1', tenantId: TENANT_ID, plan: 'professional', billingCycle: 'monthly', status: 'Active',
    });
    const { useCase } = makeUseCase(existing);
    await expect(
      useCase.execute({ tenantId: TENANT_ID, plan: 'business', billingCycle: 'monthly', clinicName: 'x', clinicEmail: 'x@x.com', clinicCpfCnpj: '1', billingType: 'PIX' }),
    ).rejects.toThrow(ConflictException);
  });

  it('permite nova assinatura se a anterior está Cancelled', async () => {
    const existing = ClinicSubscription.reconstitute({
      id: 's1', tenantId: TENANT_ID, plan: 'professional', billingCycle: 'monthly', status: 'Cancelled',
    });
    const { useCase } = makeUseCase(existing);
    await expect(
      useCase.execute({ tenantId: TENANT_ID, plan: 'business', billingCycle: 'monthly', clinicName: 'x', clinicEmail: 'x@x.com', clinicCpfCnpj: '1', billingType: 'PIX' }),
    ).resolves.toBeDefined();
  });

  it('calcula o valor anual com 10% de desconto ao criar assinatura anual', async () => {
    const { useCase, paymentProvider } = makeUseCase();
    await useCase.execute({
      tenantId: TENANT_ID, plan: 'business', billingCycle: 'yearly',
      clinicName: 'x', clinicEmail: 'x@x.com', clinicCpfCnpj: '1', billingType: 'PIX',
    });
    const call = paymentProvider.createSubscription.mock.calls[0][0];
    expect(call.value).toBeCloseTo(10767.6, 1);
    expect(call.cycle).toBe('YEARLY');
  });
});
