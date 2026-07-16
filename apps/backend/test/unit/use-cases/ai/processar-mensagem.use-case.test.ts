import { describe, it, expect, vi } from 'vitest';
import { ProcessarMensagemUseCase } from '@use-cases/ai/processar-mensagem.use-case';

function makeUseCase(
  intentResult: unknown,
  routerResult: { actionTaken: boolean; actionSummary?: string } = { actionTaken: false },
  usage = { inputTokens: 500, outputTokens: 150, costEstimate: 0.02, latencyMs: 800 },
) {
  const aiProvider = {
    interpretIntent: vi.fn().mockResolvedValue(intentResult),
    generateResponse: vi.fn().mockResolvedValue({ message: 'Olá, tudo bem? 😊', usage }),
  };
  const auditService = { recordAll: vi.fn().mockResolvedValue(undefined) };
  const intentActionRouter = { route: vi.fn().mockResolvedValue(routerResult) };
  const useCase = new ProcessarMensagemUseCase(aiProvider, auditService, intentActionRouter);
  return { useCase, aiProvider, auditService, intentActionRouter };
}

describe('ProcessarMensagemUseCase', () => {
  it('caso linear (sem escalonamento) tenta rotear a ação', async () => {
    const { useCase, intentActionRouter } = makeUseCase({ intent: 'agendar_consulta', confidence: 0.9, entities: {}, requiresEscalation: false });
    const result = await useCase.execute({ tenantId: 't1', conversationHistory: [], message: 'Quero agendar uma consulta' });
    expect(result.requiresEscalation).toBe(false);
    expect(intentActionRouter.route).toHaveBeenCalledOnce();
  });

  it('caso ambíguo aciona escalonamento e NUNCA tenta rotear ação (regra de segurança)', async () => {
    const { useCase, intentActionRouter } = makeUseCase({
      intent: 'outro',
      confidence: 0.3,
      entities: {},
      requiresEscalation: true,
      escalationReason: 'Mensagem menciona sofrimento emocional além do administrativo.',
    });
    const result = await useCase.execute({ tenantId: 't1', conversationHistory: [], message: 'não sei se aguento mais' });
    expect(result.requiresEscalation).toBe(true);
    expect(result.escalationReason).toContain('sofrimento emocional');
    expect(intentActionRouter.route).not.toHaveBeenCalled();
  });

  it('quando a ação é executada, actionTaken=true é refletido no resultado', async () => {
    const { useCase } = makeUseCase(
      { intent: 'confirmar_presenca', confidence: 0.95, entities: { appointmentId: 'a1' }, requiresEscalation: false },
      { actionTaken: true, actionSummary: 'Presença confirmada.' },
    );
    const result = await useCase.execute({ tenantId: 't1', patientId: 'p1', conversationHistory: [], message: 'confirmo' });
    expect(result.actionTaken).toBe(true);
  });

  it('quando a ação NÃO é executada (entidades insuficientes), actionTaken=false', async () => {
    const { useCase } = makeUseCase(
      { intent: 'agendar_consulta', confidence: 0.9, entities: {}, requiresEscalation: false },
      { actionTaken: false },
    );
    const result = await useCase.execute({ tenantId: 't1', conversationHistory: [], message: 'quero agendar' });
    expect(result.actionTaken).toBe(false);
  });

  it('injeta o resumo da ação executada no contexto passado para generateResponse', async () => {
    const { useCase, aiProvider } = makeUseCase(
      { intent: 'confirmar_presenca', confidence: 0.95, entities: { appointmentId: 'a1' }, requiresEscalation: false },
      { actionTaken: true, actionSummary: 'Presença confirmada.' },
    );
    await useCase.execute({ tenantId: 't1', patientId: 'p1', conversationHistory: [], message: 'confirmo' });
    const callArg = aiProvider.generateResponse.mock.calls[0][0];
    const lastMessage = callArg.conversationHistory[callArg.conversationHistory.length - 1];
    expect(lastMessage.content).toContain('Presença confirmada.');
  });

  it('audita toda interação com actorType ai_agent (Módulo 10)', async () => {
    const { useCase, auditService } = makeUseCase({ intent: 'agendar_consulta', confidence: 0.9, entities: {}, requiresEscalation: false });
    await useCase.execute({ tenantId: 't1', patientId: 'p1', conversationHistory: [], message: 'oi' });
    expect(auditService.recordAll).toHaveBeenCalledWith(expect.any(Array), 'ai_agent');
  });

  it('não lança erro quando custo se aproxima do teto (RNF-021) — apenas alerta, nunca bloqueia', async () => {
    const { useCase } = makeUseCase(
      { intent: 'agendar_consulta', confidence: 0.9, entities: {}, requiresEscalation: false },
      { actionTaken: false },
      { inputTokens: 5000, outputTokens: 3000, costEstimate: 0.2, latencyMs: 800 },
    );
    await expect(useCase.execute({ tenantId: 't1', conversationHistory: [], message: 'oi' })).resolves.toBeDefined();
  });
});
