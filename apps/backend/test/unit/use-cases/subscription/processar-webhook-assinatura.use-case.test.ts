import { describe, it, expect, vi } from 'vitest';
import { ProcessarWebhookAssinaturaUseCase } from '@use-cases/subscription/processar-webhook-assinatura.use-case';
import { ClinicSubscription } from '@domain/subscription/clinic-subscription.entity';
import { TenantContext } from '@shared/tenant-context';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function activeSub(status: 'Trialing' | 'Active' | 'PastDue' | 'Cancelled' = 'Trialing') {
  return ClinicSubscription.reconstitute({
    id: 's1', tenantId: TENANT_ID, plan: 'professional', billingCycle: 'monthly', status, asaasSubscriptionId: 'sub_456',
  });
}

function makeUseCase(subscription: ClinicSubscription | null, alreadyProcessed = false) {
  const subscriptionRepo = { findByTenantId: vi.fn(), findByAsaasSubscriptionId: vi.fn().mockResolvedValue(subscription), save: vi.fn().mockResolvedValue(undefined) };
  const webhookRepo = { wasProcessed: vi.fn().mockResolvedValue(alreadyProcessed), markProcessed: vi.fn().mockResolvedValue(undefined) };
  const auditService = { recordAll: vi.fn().mockResolvedValue(undefined) };
  const tenantContext = new TenantContext();
  const useCase = new ProcessarWebhookAssinaturaUseCase(subscriptionRepo, webhookRepo, auditService, tenantContext);
  return { useCase, subscriptionRepo, webhookRepo, auditService };
}

describe('ProcessarWebhookAssinaturaUseCase — idempotência (entrega at-least-once da Asaas)', () => {
  it('evento já processado nunca é reprocessado', async () => {
    const { useCase, subscriptionRepo } = makeUseCase(activeSub(), true);
    await useCase.execute({ id: 'evt_1', event: 'PAYMENT_CONFIRMED', subscription: { id: 'sub_456' } });
    expect(subscriptionRepo.findByAsaasSubscriptionId).not.toHaveBeenCalled();
  });

  it('PAYMENT_CONFIRMED transiciona Trialing → Active', async () => {
    const sub = activeSub('Trialing');
    const { useCase, subscriptionRepo, webhookRepo } = makeUseCase(sub);
    await useCase.execute({ id: 'evt_2', event: 'PAYMENT_CONFIRMED', subscription: { id: 'sub_456' } });
    expect(sub.status).toBe('Active');
    expect(subscriptionRepo.save).toHaveBeenCalledOnce();
    expect(webhookRepo.markProcessed).toHaveBeenCalledWith('evt_2', 'PAYMENT_CONFIRMED');
  });

  it('PAYMENT_OVERDUE transiciona Active → PastDue', async () => {
    const sub = activeSub('Active');
    const { useCase } = makeUseCase(sub);
    await useCase.execute({ id: 'evt_3', event: 'PAYMENT_OVERDUE', subscription: { id: 'sub_456' } });
    expect(sub.status).toBe('PastDue');
  });

  it('SUBSCRIPTION_DELETED transiciona para Cancelled', async () => {
    const sub = activeSub('Active');
    const { useCase } = makeUseCase(sub);
    await useCase.execute({ id: 'evt_4', event: 'SUBSCRIPTION_DELETED', subscription: { id: 'sub_456' } });
    expect(sub.status).toBe('Cancelled');
  });

  it('evento desconhecido (sem mapeamento) é marcado como processado, mas não altera estado', async () => {
    const sub = activeSub('Active');
    const { useCase, subscriptionRepo, webhookRepo } = makeUseCase(sub);
    await useCase.execute({ id: 'evt_5', event: 'CUSTOMER_UPDATED', subscription: { id: 'sub_456' } });
    expect(sub.status).toBe('Active');
    expect(subscriptionRepo.save).not.toHaveBeenCalled();
    expect(webhookRepo.markProcessed).toHaveBeenCalledWith('evt_5', 'CUSTOMER_UPDATED');
  });

  it('assinatura Asaas sem correspondente local não lança erro, apenas ignora', async () => {
    const { useCase, webhookRepo } = makeUseCase(null);
    await expect(
      useCase.execute({ id: 'evt_6', event: 'PAYMENT_CONFIRMED', subscription: { id: 'sub_inexistente' } }),
    ).resolves.not.toThrow();
    expect(webhookRepo.markProcessed).toHaveBeenCalledOnce();
  });

  it('renovação (PAYMENT_RECEIVED em assinatura já Active) avança o ciclo e persiste — BUG PRÉ-EXISTENTE CORRIGIDO NESTA SPRINT (antes era tratada como redundante e ignorada)', async () => {
    const sub = activeSub('Active');
    const { useCase, subscriptionRepo, auditService } = makeUseCase(sub);
    await useCase.execute({ id: 'evt_7', event: 'PAYMENT_RECEIVED', subscription: { id: 'sub_456' } });
    expect(subscriptionRepo.save).toHaveBeenCalledOnce();
    expect(auditService.recordAll).toHaveBeenCalledOnce();
    expect(sub.currentPeriodEnd).toBeInstanceOf(Date);
  });

  it('evento não-Active redundante (ex: novo PAYMENT_OVERDUE já em PastDue) continua sem chamar save/audit', async () => {
    const sub = activeSub('PastDue');
    const { useCase, subscriptionRepo, auditService } = makeUseCase(sub);
    await useCase.execute({ id: 'evt_9', event: 'PAYMENT_OVERDUE', subscription: { id: 'sub_456' } });
    expect(subscriptionRepo.save).not.toHaveBeenCalled();
    expect(auditService.recordAll).not.toHaveBeenCalled();
  });

  it('renovação aplica downgrade agendado quando o ciclo vira (CEO-DEC-002.5, CEO-DEC-003.6)', async () => {
    const sub = ClinicSubscription.reconstitute({
      id: 's1',
      tenantId: TENANT_ID,
      plan: 'enterprise',
      billingCycle: 'monthly',
      status: 'Active',
      asaasSubscriptionId: 'sub_456',
      currentPeriodEnd: new Date('2026-08-01'),
      pendingPlan: 'professional',
    });
    const { useCase } = makeUseCase(sub);
    await useCase.execute({ id: 'evt_10', event: 'PAYMENT_RECEIVED', subscription: { id: 'sub_456' } });
    expect(sub.plan).toBe('professional');
    expect(sub.pendingPlan).toBeUndefined();
  });

  it('lê o id da assinatura de payment.subscription quando subscription não vem no payload', async () => {
    const sub = activeSub('Trialing');
    const { useCase, subscriptionRepo } = makeUseCase(sub);
    await useCase.execute({ id: 'evt_8', event: 'PAYMENT_CONFIRMED', payment: { subscription: 'sub_456' } });
    expect(subscriptionRepo.findByAsaasSubscriptionId).toHaveBeenCalledWith('sub_456');
  });
});

describe('ProcessarWebhookAssinaturaUseCase — payload inválido (Fase 3)', () => {
  it.each([
    ['sem id', { event: 'PAYMENT_CONFIRMED', subscription: { id: 'sub_456' } }],
    ['sem tipo de evento', { id: 'evt_x', subscription: { id: 'sub_456' } }],
    ['corpo vazio', {}],
    ['corpo ausente', undefined],
  ])('%s: não consulta, não altera e não registra nada', async (_label, payload) => {
    const { useCase, subscriptionRepo, webhookRepo, auditService } = makeUseCase(activeSub());

    await expect(useCase.execute(payload as never)).resolves.toBeUndefined();

    expect(webhookRepo.wasProcessed).not.toHaveBeenCalled();
    expect(webhookRepo.markProcessed).not.toHaveBeenCalled();
    expect(subscriptionRepo.findByAsaasSubscriptionId).not.toHaveBeenCalled();
    expect(subscriptionRepo.save).not.toHaveBeenCalled();
    expect(auditService.recordAll).not.toHaveBeenCalled();
  });
});

describe('ProcessarWebhookAssinaturaUseCase — evento que não cabe no estado atual (Fase 3)', () => {
  it.each(['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_OVERDUE'])(
    '%s para assinatura Cancelled: não lança, não salva, não audita, e registra o evento como processado',
    async (event) => {
      const sub = activeSub('Cancelled');
      const { useCase, subscriptionRepo, webhookRepo, auditService } = makeUseCase(sub);

      await expect(useCase.execute({ id: 'evt_tardio', event, payment: { subscription: 'sub_456' } })).resolves.toBeUndefined();

      expect(sub.status).toBe('Cancelled');
      expect(subscriptionRepo.save).not.toHaveBeenCalled();
      expect(auditService.recordAll).not.toHaveBeenCalled();
      expect(webhookRepo.markProcessed).toHaveBeenCalledTimes(1);
      expect(webhookRepo.markProcessed).toHaveBeenCalledWith('evt_tardio', event);
    },
  );

  it('erro que não é de transição de estado continua subindo (a Asaas precisa reenviar)', async () => {
    const sub = activeSub('Trialing');
    const { useCase, subscriptionRepo, webhookRepo } = makeUseCase(sub);
    subscriptionRepo.save.mockRejectedValue(new Error('banco indisponível'));

    await expect(useCase.execute({ id: 'evt_banco', event: 'PAYMENT_CONFIRMED', subscription: { id: 'sub_456' } })).rejects.toThrow(
      'banco indisponível',
    );
    expect(webhookRepo.markProcessed).not.toHaveBeenCalled();
  });
});

/**
 * CARACTERIZAÇÃO — Fase 3B da auditoria. Não é o comportamento desejado; é o
 * comportamento atual, fixado para sustentar uma decisão pendente (D8 em
 * docs/04-API/02-Contratos-de-Integracoes-Externas.md).
 *
 * Pela documentação da Asaas, uma mesma cobrança por cartão gera
 * PAYMENT_CONFIRMED e, 32 dias depois, PAYMENT_RECEIVED. Os dois eventos têm
 * hoje o mesmo efeito. Consequência: a liquidação da mensalidade ANTERIOR
 * chega quando a assinatura já pode estar em atraso pela mensalidade atual —
 * e a reativa. Quando a regra for decidida, estes testes devem ser invertidos.
 */
describe('ProcessarWebhookAssinaturaUseCase — CARACTERIZAÇÃO: PAYMENT_RECEIVED conta como nova confirmação (decisão pendente)', () => {
  it('PAYMENT_RECEIVED em assinatura PastDue a reativa', async () => {
    const sub = activeSub('PastDue');
    const { useCase, subscriptionRepo } = makeUseCase(sub);

    await useCase.execute({ id: 'evt_liquidacao', event: 'PAYMENT_RECEIVED', payment: { subscription: 'sub_456' } });

    expect(sub.status).toBe('Active');
    expect(subscriptionRepo.save).toHaveBeenCalledOnce();
  });

  it('PAYMENT_CONFIRMED e PAYMENT_RECEIVED da mesma cobrança avançam o ciclo duas vezes (dois save)', async () => {
    const sub = activeSub('Trialing');
    const { useCase, subscriptionRepo } = makeUseCase(sub);

    await useCase.execute({ id: 'evt_confirmada', event: 'PAYMENT_CONFIRMED', payment: { subscription: 'sub_456' } });
    await useCase.execute({ id: 'evt_recebida', event: 'PAYMENT_RECEIVED', payment: { subscription: 'sub_456' } });

    expect(sub.status).toBe('Active');
    expect(subscriptionRepo.save).toHaveBeenCalledTimes(2);
  });
});
