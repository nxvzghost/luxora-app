import { describe, it, expect, vi } from 'vitest';
import {
  ListarNotificacoesUseCase,
  ContarNotificacoesNaoLidasUseCase,
  MarcarNotificacaoComoLidaUseCase,
} from '@use-cases/notification/notification.use-cases';
import { Notification } from '@domain/notification/notification.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function fakeNotification(id: string) {
  return Notification.create({
    id,
    tenantId: TENANT_ID,
    type: 'payment_divergent',
    title: 'Pagamento divergente',
    message: 'mensagem',
    entityType: 'Payment',
    entityId: 'pay1',
  });
}

describe('ListarNotificacoesUseCase', () => {
  it('delega ao NotificationRepository.findByTenant com os params recebidos', async () => {
    const notifications = [fakeNotification('n1'), fakeNotification('n2')];
    const repo = { create: vi.fn(), findById: vi.fn(), findByTenant: vi.fn().mockResolvedValue(notifications), countUnreadByTenant: vi.fn(), markAsRead: vi.fn() };
    const useCase = new ListarNotificacoesUseCase(repo);

    const result = await useCase.execute({ cursor: 'c1', limit: 20 });

    expect(repo.findByTenant).toHaveBeenCalledWith({ cursor: 'c1', limit: 20 });
    expect(result).toBe(notifications);
  });

  it('funciona sem params (undefined é repassado ao repository)', async () => {
    const repo = { create: vi.fn(), findById: vi.fn(), findByTenant: vi.fn().mockResolvedValue([]), countUnreadByTenant: vi.fn(), markAsRead: vi.fn() };
    const useCase = new ListarNotificacoesUseCase(repo);

    await useCase.execute();

    expect(repo.findByTenant).toHaveBeenCalledWith(undefined);
  });
});

describe('ContarNotificacoesNaoLidasUseCase', () => {
  it('delega ao NotificationRepository.countUnreadByTenant', async () => {
    const repo = { create: vi.fn(), findById: vi.fn(), findByTenant: vi.fn(), countUnreadByTenant: vi.fn().mockResolvedValue(7), markAsRead: vi.fn() };
    const useCase = new ContarNotificacoesNaoLidasUseCase(repo);

    const result = await useCase.execute();

    expect(repo.countUnreadByTenant).toHaveBeenCalledOnce();
    expect(result).toBe(7);
  });
});

describe('MarcarNotificacaoComoLidaUseCase', () => {
  it('delega ao NotificationRepository.markAsRead com o id recebido', async () => {
    const repo = { create: vi.fn(), findById: vi.fn(), findByTenant: vi.fn(), countUnreadByTenant: vi.fn(), markAsRead: vi.fn().mockResolvedValue(undefined) };
    const useCase = new MarcarNotificacaoComoLidaUseCase(repo);

    await useCase.execute('n1');

    expect(repo.markAsRead).toHaveBeenCalledWith('n1');
  });
});
