import { describe, it, expect, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { Billing, BillingState } from '@domain/billing/billing.entity';
import { Notification } from '@domain/notification/notification.entity';
import { MessageChannelNotConnectedError } from '@domain-services/communication/message-channel-status';
import { ReenviarCobrancaUseCase } from '@use-cases/billing/billing.use-cases';
import { describeMessagePurpose } from '@use-cases/communication/avisar-falha-de-envio.use-case';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const BILLING_ID = '22222222-2222-4222-8222-222222222222';

function billingIn(state: BillingState) {
  return Billing.reconstitute({
    id: BILLING_ID,
    tenantId: TENANT_ID,
    patientId: 'p1',
    amount: 300,
    dueDate: new Date('2027-02-10T00:00:00.000Z'),
    state,
  } as never);
}

function notice(id: string, type = 'whatsapp_send_failed') {
  return Notification.create({ id, tenantId: TENANT_ID, type, title: 't', message: 'm', entityType: 'Billing', entityId: BILLING_ID });
}

function makeUseCase(opts: { state?: BillingState; notices?: Notification[]; connected?: boolean } = {}) {
  const billing = billingIn(opts.state ?? 'Enviada');
  const repo = { countLinkedSessions: vi.fn().mockResolvedValue(1), save: vi.fn() };
  const patientRepo = { findById: vi.fn().mockResolvedValue({ name: 'Ana Prado', phone: '+5541999990000' }) };
  const clinicRepo = { findByTenantId: vi.fn().mockResolvedValue({ pixKey: 'pix@clinica', payeeName: 'Clínica' }) };
  const notificationRepo = {
    findUnreadByEntity: vi.fn().mockResolvedValue(opts.notices ?? [notice('n-novo'), notice('n-antigo', 'whatsapp_delivery_failed')]),
    markAsRead: vi.fn().mockResolvedValue(undefined),
  };
  const consultarCobranca = { execute: vi.fn().mockResolvedValue(billing) };
  const messageQueue = { enqueue: vi.fn().mockResolvedValue(undefined) };
  const auditService = { recordAll: vi.fn().mockResolvedValue(undefined) };
  const messageChannel = { isConnected: vi.fn().mockResolvedValue(opts.connected ?? true) };
  const useCase = new ReenviarCobrancaUseCase(
    repo as never,
    patientRepo as never,
    clinicRepo as never,
    notificationRepo as never,
    consultarCobranca as never,
    messageQueue as never,
    auditService as never,
    messageChannel as never,
  );
  return { useCase, repo, notificationRepo, messageQueue, auditService, billing };
}

describe('ReenviarCobrancaUseCase — reenvio depois de um aviso de falha', () => {
  it('reenvia a mesma mensagem com uma chave derivada do aviso mais novo, dá os avisos por tratados e registra na auditoria', async () => {
    const deps = makeUseCase();

    const result = await deps.useCase.execute(BILLING_ID);

    expect(result.state).toBe('Enviada');
    expect(deps.repo.save).not.toHaveBeenCalled();
    expect(deps.notificationRepo.findUnreadByEntity).toHaveBeenCalledWith(BILLING_ID, ['whatsapp_send_failed', 'whatsapp_delivery_failed']);
    expect(deps.messageQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, toPhoneNumber: '+5541999990000', idempotencyKey: `billing-${BILLING_ID}-resend-n-novo` }),
    );
    expect(deps.messageQueue.enqueue.mock.calls[0][0].body).toContain('Ana');
    expect(deps.notificationRepo.markAsRead.mock.calls.map((call) => call[0])).toEqual(['n-novo', 'n-antigo']);
    const [event] = deps.auditService.recordAll.mock.calls[0][0] as Array<{ eventName: string; entityId: string; failureNoticeId: string }>;
    expect(event).toMatchObject({ eventName: 'CobrancaReenviada', entityId: BILLING_ID, failureNoticeId: 'n-novo' });
  });

  it('sem aviso de falha em aberto: 409, nada enviado', async () => {
    const deps = makeUseCase({ notices: [] });
    await expect(deps.useCase.execute(BILLING_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(deps.messageQueue.enqueue).not.toHaveBeenCalled();
    expect(deps.auditService.recordAll).not.toHaveBeenCalled();
  });

  it.each(['Criada', 'Quitada', 'Cancelada', 'Atrasada'] as const)('cobrança "%s": 409, nada enviado', async (state) => {
    const deps = makeUseCase({ state });
    await expect(deps.useCase.execute(BILLING_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(deps.messageQueue.enqueue).not.toHaveBeenCalled();
  });

  it.each(['Enviada', 'Visualizada', 'Pendente'] as const)('cobrança "%s": pode reenviar', async (state) => {
    const deps = makeUseCase({ state });
    await deps.useCase.execute(BILLING_ID);
    expect(deps.messageQueue.enqueue).toHaveBeenCalledOnce();
  });

  it('WhatsApp desconectado: recusado antes de mexer nos avisos', async () => {
    const deps = makeUseCase({ connected: false });
    await expect(deps.useCase.execute(BILLING_ID)).rejects.toBeInstanceOf(MessageChannelNotConnectedError);
    expect(deps.notificationRepo.markAsRead).not.toHaveBeenCalled();
    expect(deps.messageQueue.enqueue).not.toHaveBeenCalled();
  });

  it('a falha do reenvio vira aviso da mesma cobrança — o botão volta', () => {
    expect(describeMessagePurpose(`billing-${BILLING_ID}-resend-n-novo`)).toMatchObject({ label: 'A cobrança', entityType: 'Billing', entityId: BILLING_ID });
  });
});
