import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ProcessarMensagemWhatsAppUseCase } from '@use-cases/communication/processar-mensagem-whatsapp.use-case';
import { Conversation, Message } from '@domain/communication/conversation.entity';
import { MetricsService } from '@shared/metrics.service';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function fakeMessage(id: string, direction: 'entrada' | 'saida', content: string) {
  return Message.reconstitute({ id, conversationId: 'c1', tenantId: TENANT_ID, direction, content });
}

function makeDeps(opts: { conversation?: Conversation | null; history?: Message[] }) {
  const conversation =
    opts.conversation === undefined
      ? Conversation.reconstitute({ id: 'c1', tenantId: TENANT_ID, phoneNumber: '+5541999990000', patientId: 'p1' })
      : opts.conversation;

  const processarMensagem = { execute: vi.fn().mockResolvedValue({ responseMessage: 'Claro, temos horário amanhã às 10h!', requiresEscalation: false, actionTaken: true }) };
  const conversationRepo = {
    findById: vi.fn().mockResolvedValue(conversation),
    findMessagesByConversationId: vi.fn().mockResolvedValue(opts.history ?? []),
    findByTenantAndPhone: vi.fn(),
    save: vi.fn(),
    appendMessages: vi.fn().mockResolvedValue(undefined),
    findMessageByExternalId: vi.fn(),
  };
  const auditService = { recordAll: vi.fn().mockResolvedValue(undefined) };
  const reconhecerOuCriarContato = { execute: vi.fn().mockResolvedValue({ id: 'contact-1', state: 'Conversando' }) };
  const metrics = new MetricsService();

  const useCase = new ProcessarMensagemWhatsAppUseCase(
    processarMensagem as never,
    conversationRepo as never,
    auditService as never,
    reconhecerOuCriarContato as never,
    metrics,
  );

  return { useCase, processarMensagem, conversationRepo, auditService, reconhecerOuCriarContato, metrics, conversation };
}

describe('ProcessarMensagemWhatsAppUseCase — ADR-0053 (AD-007), escopo revisado por ADR-0054 (AD-036)', () => {
  it('lança NotFoundException se a Conversation do job não existir', async () => {
    const { useCase } = makeDeps({ conversation: null });
    await expect(
      useCase.execute({ tenantId: TENANT_ID, conversationId: 'c1', message: 'Olá', externalId: 'wamid.1' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('exclui o próprio turno atual do histórico passado a ProcessarMensagemUseCase (evita duplicar a mensagem)', async () => {
    const history = [fakeMessage('m1', 'entrada', 'Oi'), fakeMessage('m2', 'saida', 'Olá!'), fakeMessage('m3', 'entrada', 'Tem horário amanhã?')];
    const { useCase, processarMensagem } = makeDeps({ history });

    await useCase.execute({ tenantId: TENANT_ID, conversationId: 'c1', patientId: 'p1', message: 'Tem horário amanhã?', externalId: 'wamid.3' });

    expect(processarMensagem.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationHistory: [
          { role: 'user', content: 'Oi' },
          { role: 'assistant', content: 'Olá!' },
        ],
        message: 'Tem horário amanhã?',
      }),
    );
  });

  it('grava a resposta da IA como Message de saída e audita como "ai_agent"-flow via system', async () => {
    const { useCase, conversationRepo, auditService } = makeDeps({});
    await useCase.execute({ tenantId: TENANT_ID, conversationId: 'c1', message: 'Olá', externalId: 'wamid.1' });

    expect(conversationRepo.appendMessages).toHaveBeenCalledOnce();
    const [messages] = conversationRepo.appendMessages.mock.calls[0];
    expect(messages).toHaveLength(1);
    expect(messages[0].direction).toBe('saida');
    expect(auditService.recordAll).toHaveBeenCalledWith(expect.any(Array), 'system');
  });

  it('não despacha mais o envio — retorna responseMessage/toPhoneNumber para o worker decidir quando despachar (ADR-0054)', async () => {
    const { useCase, conversation } = makeDeps({});
    const result = await useCase.execute({ tenantId: TENANT_ID, conversationId: 'c1', message: 'Olá', externalId: 'wamid.42' });

    expect(result).toEqual({
      responseMessage: 'Claro, temos horário amanhã às 10h!',
      toPhoneNumber: conversation!.phoneNumber,
    });
  });

  describe('ADR-0055 (AD-018), Fase 7 — re-resolução do Contact', () => {
    it('re-resolve o Contact via ReconhecerOuCriarContatoUseCase, usando tenantId e conversation.phoneNumber (nunca um objeto de domínio)', async () => {
      const { useCase, reconhecerOuCriarContato, conversation } = makeDeps({});
      await useCase.execute({ tenantId: TENANT_ID, conversationId: 'c1', message: 'Olá', externalId: 'wamid.1' });

      expect(reconhecerOuCriarContato.execute).toHaveBeenCalledWith(TENANT_ID, conversation!.phoneNumber);
    });

    it('repassa contactId e correlationId para ProcessarMensagemUseCase', async () => {
      const { useCase, processarMensagem } = makeDeps({});
      await useCase.execute({ tenantId: TENANT_ID, conversationId: 'c1', message: 'Olá', externalId: 'wamid.1', correlationId: 'corr-9' });

      expect(processarMensagem.execute).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: 'contact-1', correlationId: 'corr-9' }),
      );
    });
  });

  describe('ADR-0055 (AD-018), Fase 8.2 — métricas', () => {
    it('sucesso: observa whatsapp_message_processing_duration_ms e incrementa outcome=success', async () => {
      const { useCase, metrics } = makeDeps({});
      await useCase.execute({ tenantId: TENANT_ID, conversationId: 'c1', message: 'Olá', externalId: 'wamid.1' });

      expect(metrics.getObservationStats('whatsapp_message_processing_duration_ms')?.count).toBe(1);
      expect(metrics.getCounter('whatsapp_messages_processed_total', { outcome: 'success' })).toBe(1);
    });

    it('erro: observa duração e incrementa outcome=error, sem mascarar a exceção original', async () => {
      const { useCase, metrics } = makeDeps({ conversation: null });

      await expect(
        useCase.execute({ tenantId: TENANT_ID, conversationId: 'c1', message: 'Olá', externalId: 'wamid.1' }),
      ).rejects.toThrow(NotFoundException);

      expect(metrics.getObservationStats('whatsapp_message_processing_duration_ms')?.count).toBe(1);
      expect(metrics.getCounter('whatsapp_messages_processed_total', { outcome: 'error' })).toBe(1);
      expect(metrics.getCounter('whatsapp_messages_processed_total', { outcome: 'success' })).toBe(0);
    });
  });
});
