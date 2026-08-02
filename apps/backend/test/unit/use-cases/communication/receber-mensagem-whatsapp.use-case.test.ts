import { describe, it, expect, vi } from 'vitest';
import { ReceberMensagemWhatsAppUseCase, WhatsAppWebhookPayload } from '@use-cases/communication/receber-mensagem-whatsapp.use-case';
import { Conversation } from '@domain/communication/conversation.entity';
import { TenantContext } from '@shared/tenant-context';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const PHONE_NUMBER_ID = 'pnid-1';
const FROM = '+5541999990000';

function makePrismaClient(integration: { tenantId: string; active: boolean } | null) {
  return {
    whatsAppIntegration: { findUnique: vi.fn().mockResolvedValue(integration) },
  } as never;
}

function makeDeps(opts: {
  integration?: { tenantId: string; active: boolean } | null;
  existingMessage?: unknown;
  existingConversation?: Conversation | null;
  patient?: { id: string } | null;
}) {
  // 'integration' in opts, não ??: um valor explicitamente null (caso de
  // teste "phoneNumberId sem Tenant conectado") não pode cair no default
  // via nullish coalescing, que trata null e undefined como equivalentes.
  const integration = 'integration' in opts ? opts.integration! : { tenantId: TENANT_ID, active: true };
  const prismaClient = makePrismaClient(integration);
  const tenantContext = new TenantContext();
  const conversationRepo = {
    findMessageByExternalId: vi.fn().mockResolvedValue(opts.existingMessage ?? null),
    findByTenantAndPhone: vi.fn().mockResolvedValue(opts.existingConversation ?? null),
    findById: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    appendMessages: vi.fn().mockResolvedValue(undefined),
    findMessagesByConversationId: vi.fn(),
  };
  const patientRepo = { findByPhone: vi.fn().mockResolvedValue(opts.patient ?? null), findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn() };
  const auditService = { recordAll: vi.fn().mockResolvedValue(undefined) };
  const inboundQueue = { enqueue: vi.fn().mockResolvedValue(undefined) };
  const reconhecerOuCriarContatoUseCase = { execute: vi.fn().mockResolvedValue({ id: 'contact-1', state: 'Conversando' }) };
  const correlationContext = { correlationId: 'corr-fake' };

  const useCase = new ReceberMensagemWhatsAppUseCase(
    prismaClient,
    tenantContext,
    conversationRepo as never,
    patientRepo as never,
    auditService as never,
    inboundQueue as never,
    reconhecerOuCriarContatoUseCase as never,
    correlationContext as never,
  );

  return { useCase, prismaClient, tenantContext, conversationRepo, patientRepo, auditService, inboundQueue, reconhecerOuCriarContatoUseCase, correlationContext };
}

function payloadWith(messageId: string, body: string, phoneNumberId = PHONE_NUMBER_ID): WhatsAppWebhookPayload {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: phoneNumberId },
              messages: [{ id: messageId, from: FROM, type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
}

describe('ReceberMensagemWhatsAppUseCase — ADR-0053 (AD-007)', () => {
  it('ignora silenciosamente um phoneNumberId sem Tenant conectado', async () => {
    const { useCase, conversationRepo } = makeDeps({ integration: null });
    await useCase.execute(payloadWith('wamid.1', 'Olá'));
    expect(conversationRepo.findMessageByExternalId).not.toHaveBeenCalled();
  });

  it('idempotência: WAMID já processado nunca cria Conversation, nunca reenfileira, e nunca reconhece/cria Contact', async () => {
    const { useCase, conversationRepo, inboundQueue, reconhecerOuCriarContatoUseCase } = makeDeps({ existingMessage: { id: 'm-existing' } });
    await useCase.execute(payloadWith('wamid.1', 'Olá'));
    expect(conversationRepo.save).not.toHaveBeenCalled();
    expect(inboundQueue.enqueue).not.toHaveBeenCalled();
    expect(reconhecerOuCriarContatoUseCase.execute).not.toHaveBeenCalled();
  });

  it('mensagem nova, número desconhecido: cria Conversation com patientId null', async () => {
    const { useCase, conversationRepo, inboundQueue } = makeDeps({ patient: null });
    await useCase.execute(payloadWith('wamid.1', 'Olá, quero agendar uma consulta'));

    expect(conversationRepo.save).toHaveBeenCalledOnce();
    const savedConversation = conversationRepo.save.mock.calls[0][0] as Conversation;
    expect(savedConversation.patientId).toBeNull();
    expect(inboundQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, externalId: 'wamid.1', message: 'Olá, quero agendar uma consulta' }),
    );
  });

  it('mensagem nova, número já é de um Patient cadastrado: Conversation nasce com patientId resolvido', async () => {
    const { useCase, conversationRepo } = makeDeps({ patient: { id: 'p1' } });
    await useCase.execute(payloadWith('wamid.1', 'Olá'));

    const savedConversation = conversationRepo.save.mock.calls[0][0] as Conversation;
    expect(savedConversation.patientId).toBe('p1');
  });

  it('Conversation já existente: nunca chama save() de novo, só appendMessages()', async () => {
    const existing = Conversation.reconstitute({ id: 'c1', tenantId: TENANT_ID, phoneNumber: FROM, patientId: 'p1' });
    const { useCase, conversationRepo } = makeDeps({ existingConversation: existing });
    await useCase.execute(payloadWith('wamid.1', 'Olá de novo'));

    expect(conversationRepo.save).not.toHaveBeenCalled();
    expect(conversationRepo.appendMessages).toHaveBeenCalledOnce();
  });

  it('audita com actorType "system" — ator não-autenticado, mesmo padrão de ProcessarWebhookAssinaturaUseCase', async () => {
    const { useCase, auditService } = makeDeps({});
    await useCase.execute(payloadWith('wamid.1', 'Olá'));
    expect(auditService.recordAll).toHaveBeenCalledWith(expect.any(Array), 'system');
  });

  describe('ADR-0055 (AD-018), Fase 5 — integração com ReconhecerOuCriarContatoUseCase', () => {
    it('chama ReconhecerOuCriarContatoUseCase com o Tenant e o telefone de origem, único ponto de entrada de Contact', async () => {
      const { useCase, reconhecerOuCriarContatoUseCase } = makeDeps({});
      await useCase.execute(payloadWith('wamid.1', 'Olá'));
      expect(reconhecerOuCriarContatoUseCase.execute).toHaveBeenCalledWith(TENANT_ID, FROM);
    });

    it('fluxo de Conversation continua funcionando quando ReconhecerOuCriarContatoUseCase devolve um Contact NOVO', async () => {
      const { useCase, conversationRepo, inboundQueue, reconhecerOuCriarContatoUseCase } = makeDeps({ patient: null });
      reconhecerOuCriarContatoUseCase.execute.mockResolvedValue({ id: 'contact-novo', state: 'Conversando' });

      await useCase.execute(payloadWith('wamid.1', 'Olá, quero agendar'));

      expect(conversationRepo.save).toHaveBeenCalledOnce();
      expect(inboundQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_ID, externalId: 'wamid.1' }));
    });

    it('fluxo de Conversation continua funcionando quando ReconhecerOuCriarContatoUseCase devolve um Contact EXISTENTE', async () => {
      const existingConversation = Conversation.reconstitute({ id: 'c1', tenantId: TENANT_ID, phoneNumber: FROM, patientId: 'p1' });
      const { useCase, conversationRepo, inboundQueue, reconhecerOuCriarContatoUseCase } = makeDeps({ existingConversation });
      reconhecerOuCriarContatoUseCase.execute.mockResolvedValue({ id: 'contact-existente', state: 'Identificado' });

      await useCase.execute(payloadWith('wamid.1', 'Olá de novo'));

      expect(conversationRepo.save).not.toHaveBeenCalled();
      expect(conversationRepo.appendMessages).toHaveBeenCalledOnce();
      expect(inboundQueue.enqueue).toHaveBeenCalledOnce();
    });

    it('ADR-0055 (AD-018), Fase 8.2 — repassa CorrelationContext.correlationId para o enqueue() da fila', async () => {
      const { useCase, inboundQueue, correlationContext } = makeDeps({});
      await useCase.execute(payloadWith('wamid.1', 'Olá'));
      expect(inboundQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ correlationId: correlationContext.correlationId }));
    });

    it('mensagens ignoradas (sem Tenant conectado, ou não-texto) nunca chegam a chamar ReconhecerOuCriarContatoUseCase', async () => {
      const semTenant = makeDeps({ integration: null });
      await semTenant.useCase.execute(payloadWith('wamid.1', 'Olá'));
      expect(semTenant.reconhecerOuCriarContatoUseCase.execute).not.toHaveBeenCalled();

      const naoTexto = makeDeps({});
      const payload: WhatsAppWebhookPayload = {
        entry: [{ changes: [{ value: { metadata: { phone_number_id: PHONE_NUMBER_ID }, messages: [{ id: 'wamid.2', from: FROM, type: 'image' }] } }] }],
      };
      await naoTexto.useCase.execute(payload);
      expect(naoTexto.reconhecerOuCriarContatoUseCase.execute).not.toHaveBeenCalled();
    });
  });

  it('ignora mensagens que não são de texto (fora do mínimo necessário desta AD)', async () => {
    const { useCase, conversationRepo } = makeDeps({});
    const payload: WhatsAppWebhookPayload = {
      entry: [{ changes: [{ value: { metadata: { phone_number_id: PHONE_NUMBER_ID }, messages: [{ id: 'wamid.2', from: FROM, type: 'image' }] } }] }],
    };
    await useCase.execute(payload);
    expect(conversationRepo.findMessageByExternalId).not.toHaveBeenCalled();
  });

  it('payload com 2 mensagens de Tenants diferentes resolve e processa cada uma sob o Tenant correto', async () => {
    const tenantContext = new TenantContext();
    const prismaClient = {
      whatsAppIntegration: {
        findUnique: vi.fn((args: { where: { phoneNumberId: string } }) =>
          Promise.resolve(
            args.where.phoneNumberId === 'pnid-A'
              ? { tenantId: 'tenant-A', active: true }
              : { tenantId: 'tenant-B', active: true },
          ),
        ),
      },
    } as never;
    const conversationRepo = {
      findMessageByExternalId: vi.fn().mockResolvedValue(null),
      findByTenantAndPhone: vi.fn().mockResolvedValue(null),
      findById: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      appendMessages: vi.fn().mockResolvedValue(undefined),
      findMessagesByConversationId: vi.fn(),
    };
    const patientRepo = { findByPhone: vi.fn().mockResolvedValue(null), findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn() };
    const auditService = { recordAll: vi.fn().mockResolvedValue(undefined) };
    const inboundQueue = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const reconhecerOuCriarContatoUseCase = { execute: vi.fn().mockResolvedValue({ id: 'contact-x', state: 'Conversando' }) };
    const correlationContext = { correlationId: 'corr-fake' };
    const useCase = new ReceberMensagemWhatsAppUseCase(
      prismaClient,
      tenantContext,
      conversationRepo as never,
      patientRepo as never,
      auditService as never,
      inboundQueue as never,
      reconhecerOuCriarContatoUseCase as never,
      correlationContext as never,
    );

    const payload: WhatsAppWebhookPayload = {
      entry: [
        {
          changes: [
            { value: { metadata: { phone_number_id: 'pnid-A' }, messages: [{ id: 'wamid.a', from: '+551', type: 'text', text: { body: 'A' } }] } },
            { value: { metadata: { phone_number_id: 'pnid-B' }, messages: [{ id: 'wamid.b', from: '+552', type: 'text', text: { body: 'B' } }] } },
          ],
        },
      ],
    };

    await useCase.execute(payload);

    const enqueuedTenants = inboundQueue.enqueue.mock.calls.map((c) => c[0].tenantId);
    expect(enqueuedTenants).toEqual(['tenant-A', 'tenant-B']);
  });
});
