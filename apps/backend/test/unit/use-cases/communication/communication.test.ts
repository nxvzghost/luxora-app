import { describe, it, expect, vi } from 'vitest';
import { buildBillingMessage } from '@use-cases/communication/templates/billing-message.template';
import { EnviarMensagemUseCase } from '@use-cases/communication/enviar-mensagem.use-case';

describe('buildBillingMessage — Padrão 7 (05-IA/01-Tom-de-Voz)', () => {
  it('segue o template literal exato documentado', () => {
    const msg = buildBillingMessage({
      patientFirstName: 'Pedro',
      sessionCount: 1,
      amountPerSession: 400,
      totalAmount: 400,
      pixKey: '41999513595',
      payeeName: 'Alessandra Lira Licks',
    });
    expect(msg).toContain('Olá, Pedro, boa tarde! 😊');
    expect(msg).toContain('💼 Sessões realizadas: 1');
    expect(msg).toContain('💰 Valor por sessão: R$400.00');
    expect(msg).toContain('📱 Chave: 41999513595');
    expect(msg).toContain('Fico à disposição para qualquer dúvida.');
  });

  it('nunca menciona suspensão, ameaça ou tom de cobrança agressiva (Teste Crítico #14)', () => {
    const msg = buildBillingMessage({
      patientFirstName: 'Ana',
      sessionCount: 4,
      amountPerSession: 400,
      totalAmount: 1600,
      pixKey: 'x',
      payeeName: 'y',
    });
    expect(msg.toLowerCase()).not.toMatch(/suspens|amea|multa|juro|cobra(r|nça) judicial/);
  });
});

describe('EnviarMensagemUseCase — idempotência (2 camadas)', () => {
  it('não reenvia quando já existe registro com a mesma idempotencyKey', async () => {
    const provider = { send: vi.fn() };
    const logRepo = {
      findByIdempotencyKey: vi.fn().mockResolvedValue({ id: 'log1', providerMessageId: 'wamid.123' }),
      record: vi.fn(),
    };
    const useCase = new EnviarMensagemUseCase(provider, logRepo);

    const result = await useCase.execute({ tenantId: 't1', toPhoneNumber: '+5541900000000', body: 'oi', idempotencyKey: 'k1' });

    expect(result.providerMessageId).toBe('wamid.123');
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('envia e registra quando é a primeira tentativa', async () => {
    const provider = { send: vi.fn().mockResolvedValue({ providerMessageId: 'wamid.456', sentAt: new Date() }) };
    const logRepo = { findByIdempotencyKey: vi.fn().mockResolvedValue(null), record: vi.fn().mockResolvedValue(undefined) };
    const useCase = new EnviarMensagemUseCase(provider, logRepo);

    const result = await useCase.execute({ tenantId: 't1', toPhoneNumber: '+5541900000000', body: 'oi', idempotencyKey: 'k2' });

    expect(result.providerMessageId).toBe('wamid.456');
    expect(logRepo.record).toHaveBeenCalledOnce();
  });
});
