import { describe, it, expect, vi } from 'vitest';
import { NotificationService } from '@domain-services/platform/notification.service';
import { PaymentStateChangedEvent } from '@domain/payment/payment.entity';
import { BillingStateChangedEvent } from '@domain/billing/billing.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const CONTEXT = { billingId: 'b1', amount: 400 };

function repoMock() {
  return { create: vi.fn().mockResolvedValue(undefined), findById: vi.fn(), findByTenant: vi.fn(), countUnreadByTenant: vi.fn(), markAsRead: vi.fn() };
}

describe('NotificationService', () => {
  it('PaymentStateChangedEvent com toState Divergente cria uma Notification', async () => {
    const repo = repoMock();
    const service = new NotificationService(repo);
    const event = new PaymentStateChangedEvent('pay1', TENANT_ID, 'Recebido', 'Divergente');

    await service.process([event], CONTEXT);

    expect(repo.create).toHaveBeenCalledOnce();
  });

  it('PaymentStateChangedEvent com outro toState não cria Notification', async () => {
    const repo = repoMock();
    const service = new NotificationService(repo);
    const event = new PaymentStateChangedEvent('pay1', TENANT_ID, 'Recebido', 'Confirmado');

    await service.process([event], CONTEXT);

    expect(repo.create).not.toHaveBeenCalled();
  });

  it('evento que não é PaymentStateChangedEvent não cria Notification, mesmo com toState Divergente coincidente', async () => {
    const repo = repoMock();
    const service = new NotificationService(repo);
    const event = new BillingStateChangedEvent('b1', TENANT_ID, 'Pendente', 'Cancelada');

    await service.process([event], CONTEXT);

    expect(repo.create).not.toHaveBeenCalled();
  });

  it('tenantId da Notification vem do evento', async () => {
    const repo = repoMock();
    const service = new NotificationService(repo);
    const event = new PaymentStateChangedEvent('pay1', TENANT_ID, 'Recebido', 'Divergente');

    await service.process([event], CONTEXT);

    const notification = repo.create.mock.calls[0][0];
    expect(notification.tenantId).toBe(TENANT_ID);
  });

  it('entityType da Notification é Payment', async () => {
    const repo = repoMock();
    const service = new NotificationService(repo);
    const event = new PaymentStateChangedEvent('pay1', TENANT_ID, 'Recebido', 'Divergente');

    await service.process([event], CONTEXT);

    const notification = repo.create.mock.calls[0][0];
    expect(notification.entityType).toBe('Payment');
  });

  it('entityId da Notification é o entityId do evento (payment.id)', async () => {
    const repo = repoMock();
    const service = new NotificationService(repo);
    const event = new PaymentStateChangedEvent('pay1', TENANT_ID, 'Recebido', 'Divergente');

    await service.process([event], CONTEXT);

    const notification = repo.create.mock.calls[0][0];
    expect(notification.entityId).toBe('pay1');
  });

  it('type da Notification é payment_divergent', async () => {
    const repo = repoMock();
    const service = new NotificationService(repo);
    const event = new PaymentStateChangedEvent('pay1', TENANT_ID, 'Recebido', 'Divergente');

    await service.process([event], CONTEXT);

    const notification = repo.create.mock.calls[0][0];
    expect(notification.type).toBe('payment_divergent');
  });

  it('a mensagem contém o billingId do contexto', async () => {
    const repo = repoMock();
    const service = new NotificationService(repo);
    const event = new PaymentStateChangedEvent('pay1', TENANT_ID, 'Recebido', 'Divergente');

    await service.process([event], { billingId: 'billing-xyz', amount: 400 });

    const notification = repo.create.mock.calls[0][0];
    expect(notification.message).toContain('billing-xyz');
  });

  it('a mensagem contém o amount do contexto', async () => {
    const repo = repoMock();
    const service = new NotificationService(repo);
    const event = new PaymentStateChangedEvent('pay1', TENANT_ID, 'Recebido', 'Divergente');

    await service.process([event], { billingId: 'b1', amount: 587.5 });

    const notification = repo.create.mock.calls[0][0];
    expect(notification.message).toContain('587.50');
  });

  it('múltiplos eventos elegíveis criam múltiplas notificações', async () => {
    const repo = repoMock();
    const service = new NotificationService(repo);
    const events = [
      new PaymentStateChangedEvent('pay1', TENANT_ID, 'Recebido', 'Divergente'),
      new PaymentStateChangedEvent('pay2', TENANT_ID, 'Recebido', 'Confirmado'),
      new PaymentStateChangedEvent('pay3', TENANT_ID, 'Recebido', 'Divergente'),
    ];

    await service.process(events, CONTEXT);

    expect(repo.create).toHaveBeenCalledTimes(2);
    expect(repo.create.mock.calls[0][0].entityId).toBe('pay1');
    expect(repo.create.mock.calls[1][0].entityId).toBe('pay3');
  });

  it('lista vazia não chama o Repository', async () => {
    const repo = repoMock();
    const service = new NotificationService(repo);

    await service.process([], CONTEXT);

    expect(repo.create).not.toHaveBeenCalled();
  });
});
