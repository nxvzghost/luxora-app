import { describe, it, expect, vi } from 'vitest';
import {
  AvisarFalhaDeEnvioUseCase,
  describeDeliveryFailure,
  describeMessagePurpose,
  describeSendFailure,
} from '@use-cases/communication/avisar-falha-de-envio.use-case';
import { Notification } from '@domain/notification/notification.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const BILLING_ID = '22222222-2222-4222-8222-222222222222';
const THERAPIST_ID = '33333333-3333-4333-8333-333333333333';

function makeDeps(opts: { unread?: boolean; log?: { id: string; idempotencyKey: string; toPhoneNumber: string; status: string } | null } = {}) {
  const notificationRepo = {
    hasUnread: vi.fn().mockResolvedValue(opts.unread ?? false),
    create: vi.fn().mockResolvedValue(undefined),
  };
  const logRepo = {
    findByProviderMessageId: vi.fn().mockResolvedValue(opts.log ?? null),
    markFailed: vi.fn().mockResolvedValue(undefined),
  };
  const useCase = new AvisarFalhaDeEnvioUseCase(notificationRepo as never, logRepo as never);
  const created = () => notificationRepo.create.mock.calls.map((call) => call[0] as Notification);
  return { useCase, notificationRepo, logRepo, created };
}

describe('describeMessagePurpose — do que se trata a mensagem, pela chave de idempotência', () => {
  it.each([
    [`billing-${BILLING_ID}`, 'A cobrança', 'Billing', BILLING_ID],
    [`billing-overdue-${BILLING_ID}-d1`, 'O lembrete de cobrança em atraso', 'Billing', BILLING_ID],
    [`billing-overdue-${BILLING_ID}-d7`, 'O lembrete de cobrança em atraso', 'Billing', BILLING_ID],
    [`agenda-summary-${THERAPIST_ID}-2026-10-19`, 'O resumo da agenda', 'Therapist', THERAPIST_ID],
    [`agenda-summary-updated-${THERAPIST_ID}-1792431426000`, 'O resumo da agenda', 'Therapist', THERAPIST_ID],
  ])('%s', (key, label, entityType, entityId) => {
    expect(describeMessagePurpose(key)).toMatchObject({ label, entityType, entityId });
  });

  it.each([
    ['conversation-reply-wamid.HBgNNTU0MTk5', 'A resposta automática da conversa'],
    ['unsupported-media-reply-wamid.HBgNNTU0MTk5', 'A resposta automática a uma mensagem que não é texto'],
    ['outra-coisa-qualquer', 'A mensagem'],
  ])('%s: referência opaca, sem o wamid', (key, label) => {
    const purpose = describeMessagePurpose(key);
    expect(purpose.label).toBe(label);
    expect(purpose.entityType).toBe('WhatsAppMessage');
    expect(purpose.entityId).toMatch(/^ref:[0-9a-f]{12}$/);
  });
});

describe('describeSendFailure / describeDeliveryFailure — motivo em linguagem da clínica', () => {
  it.each([
    ['Clínica (tenant x) não tem WhatsApp conectado. Cada clínica…', 'não está conectado'],
    ['Falha ao enviar mensagem via WhatsApp (401): code=190, subcode=ausente, type=OAuthException, fbtrace_id=t', 'credencial'],
    ['Credencial de WhatsApp da clínica (tenant x) não pôde ser decifrada.', 'credencial'],
    ['Falha ao enviar mensagem via WhatsApp (400): code=131047, subcode=ausente', '24 horas'],
    ['Falha ao enviar mensagem via WhatsApp (500): code=1, subcode=ausente', '3 tentativas'],
    ['Falha ao enviar mensagem via WhatsApp (tempo limite de 10000ms).', '3 tentativas'],
    ['Falha ao enviar mensagem via WhatsApp (400): code=100, subcode=ausente', 'recusou o envio'],
  ])('%s', (reason, expected) => {
    expect(describeSendFailure(reason)).toContain(expected);
  });

  it('status de falha: código conhecido em linguagem da clínica; desconhecido, com o número do código', () => {
    expect(describeDeliveryFailure(131047)).toContain('24 horas');
    expect(describeDeliveryFailure(131026)).toContain('não pôde receber');
    expect(describeDeliveryFailure(999)).toContain('código 999');
    expect(describeDeliveryFailure(undefined)).toBe('o WhatsApp não entregou a mensagem');
  });
});

describe('AvisarFalhaDeEnvioUseCase — A-08', () => {
  it('não enviada: aviso com assunto, final do número e motivo — sem o texto da mensagem', async () => {
    const deps = makeDeps();
    await deps.useCase.naoEnviada({
      tenantId: TENANT_ID,
      toPhoneNumber: '+55 41 99999-1234',
      idempotencyKey: `billing-${BILLING_ID}`,
      reason: 'Falha ao enviar mensagem via WhatsApp (401): code=190, subcode=ausente',
    });

    const [notice] = deps.created();
    expect(notice.tenantId).toBe(TENANT_ID);
    expect(notice.type).toBe('whatsapp_send_failed');
    expect(notice.title).toBe('WhatsApp: mensagem não enviada');
    expect(notice.entityType).toBe('Billing');
    expect(notice.entityId).toBe(BILLING_ID);
    expect(notice.message).toBe(
      'A cobrança para o número com final 1234 não foi enviada: a credencial do WhatsApp da clínica foi recusada. Reconecte o WhatsApp em Configurações. No painel ela continua como Enviada.',
    );
  });

  it('concorda o gênero do assunto', async () => {
    const deps = makeDeps();
    await deps.useCase.naoEnviada({
      tenantId: TENANT_ID,
      toPhoneNumber: '5541999991234',
      idempotencyKey: `agenda-summary-${THERAPIST_ID}-2026-10-19`,
      reason: 'Falha ao enviar mensagem via WhatsApp (falha de rede).',
    });
    expect(deps.created()[0].message).toContain('O resumo da agenda para o número com final 1234 não foi enviado:');
  });

  it('aviso igual ainda não lido: não cria outro', async () => {
    const deps = makeDeps({ unread: true });
    await deps.useCase.naoEnviada({ tenantId: TENANT_ID, toPhoneNumber: '5541999991234', idempotencyKey: `billing-${BILLING_ID}`, reason: 'x' });
    expect(deps.notificationRepo.hasUnread).toHaveBeenCalledWith('whatsapp_send_failed', BILLING_ID);
    expect(deps.notificationRepo.create).not.toHaveBeenCalled();
  });

  it('não entregue: marca o envio como falho e avisa com o motivo da Meta', async () => {
    const deps = makeDeps({ log: { id: 'log-1', idempotencyKey: `billing-overdue-${BILLING_ID}-d1`, toPhoneNumber: '5541999995678', status: 'sent' } });
    expect(await deps.useCase.naoEntregue({ tenantId: TENANT_ID, providerMessageId: 'wamid.saida', errorCode: 131047 })).toBe(true);

    expect(deps.logRepo.markFailed).toHaveBeenCalledWith('log-1');
    const [notice] = deps.created();
    expect(notice.type).toBe('whatsapp_delivery_failed');
    expect(notice.message).toBe(
      'O lembrete de cobrança em atraso para o número com final 5678 foi aceito pelo WhatsApp, mas não chegou: a pessoa não escreve à clínica há mais de 24 horas, e fora dessa janela o WhatsApp só entrega mensagem de modelo aprovado.',
    );
  });

  it('não entregue, status repetido da mesma mensagem: nada de novo', async () => {
    const deps = makeDeps({ log: { id: 'log-1', idempotencyKey: `billing-${BILLING_ID}`, toPhoneNumber: '5541999995678', status: 'failed' } });
    expect(await deps.useCase.naoEntregue({ tenantId: TENANT_ID, providerMessageId: 'wamid.saida' })).toBe(true);
    expect(deps.logRepo.markFailed).not.toHaveBeenCalled();
    expect(deps.notificationRepo.create).not.toHaveBeenCalled();
  });

  it('não entregue, envio desconhecido (de outra clínica ou não registrado): nada a fazer', async () => {
    const deps = makeDeps({ log: null });
    expect(await deps.useCase.naoEntregue({ tenantId: TENANT_ID, providerMessageId: 'wamid.desconhecido' })).toBe(false);
    expect(deps.notificationRepo.create).not.toHaveBeenCalled();
  });

  it('não entregue, sem id da mensagem: nem consulta', async () => {
    const deps = makeDeps();
    expect(await deps.useCase.naoEntregue({ tenantId: TENANT_ID, providerMessageId: '' })).toBe(false);
    expect(deps.logRepo.findByProviderMessageId).not.toHaveBeenCalled();
  });
});
