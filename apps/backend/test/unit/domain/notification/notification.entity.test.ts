import { describe, it, expect } from 'vitest';
import { Notification } from '@domain/notification/notification.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function newNotification() {
  return Notification.create({
    id: 'n1',
    tenantId: TENANT_ID,
    type: 'payment_divergent',
    title: 'Pagamento divergente',
    message: 'O pagamento p1 foi registrado com valor divergente do esperado.',
    entityType: 'Payment',
    entityId: 'p1',
  });
}

describe('Notification', () => {
  it('nasce não lida (readAt null)', () => {
    const n = newNotification();
    expect(n.readAt).toBeNull();
    expect(n.isRead).toBe(false);
  });

  it('nasce com createdAt preenchido automaticamente', () => {
    const n = newNotification();
    expect(n.createdAt).toBeInstanceOf(Date);
  });

  it('preserva os campos de origem e conteúdo informados na criação', () => {
    const n = newNotification();
    expect(n.id).toBe('n1');
    expect(n.tenantId).toBe(TENANT_ID);
    expect(n.type).toBe('payment_divergent');
    expect(n.title).toBe('Pagamento divergente');
    expect(n.message).toBe('O pagamento p1 foi registrado com valor divergente do esperado.');
    expect(n.entityType).toBe('Payment');
    expect(n.entityId).toBe('p1');
  });

  it('markAsRead() define readAt e isRead passa a true', () => {
    const n = newNotification();
    n.markAsRead();
    expect(n.readAt).toBeInstanceOf(Date);
    expect(n.isRead).toBe(true);
  });

  it('markAsRead() é idempotente — chamar de novo não altera o readAt original', () => {
    const n = newNotification();
    n.markAsRead();
    const firstReadAt = n.readAt;
    n.markAsRead();
    expect(n.readAt).toBe(firstReadAt); // mesma referência — não foi reatribuído
  });

  it('reconstitute() preserva um readAt já existente (rehidratação do banco)', () => {
    const existingReadAt = new Date('2026-01-01T12:00:00.000Z');
    const n = Notification.reconstitute({
      id: 'n2',
      tenantId: TENANT_ID,
      type: 'payment_divergent',
      title: 'Pagamento divergente',
      message: 'mensagem',
      entityType: 'Payment',
      entityId: 'p2',
      readAt: existingReadAt,
      createdAt: new Date('2026-01-01T10:00:00.000Z'),
    });
    expect(n.isRead).toBe(true);
    expect(n.readAt).toEqual(existingReadAt);
  });

  it('reconstitute() preserva uma Notification ainda não lida', () => {
    const n = Notification.reconstitute({
      id: 'n3',
      tenantId: TENANT_ID,
      type: 'payment_divergent',
      title: 'Pagamento divergente',
      message: 'mensagem',
      entityType: 'Payment',
      entityId: 'p3',
      readAt: null,
      createdAt: new Date('2026-01-01T10:00:00.000Z'),
    });
    expect(n.isRead).toBe(false);
    expect(n.readAt).toBeNull();
  });
});
