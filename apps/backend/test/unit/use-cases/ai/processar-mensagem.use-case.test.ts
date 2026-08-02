import { describe, it, expect, vi } from 'vitest';
import { ProcessarMensagemUseCase } from '@use-cases/ai/processar-mensagem.use-case';
import { MetricsService } from '@shared/metrics.service';

function makeUseCase(
  intentResult: unknown,
  routerResult: { actionTaken: boolean; actionSummary?: string } = { actionTaken: false },
  usage = { inputTokens: 500, outputTokens: 150, costEstimate: 0.02, latencyMs: 800 },
  contactRouterResult: {
    decision?: string;
    actionTaken: boolean;
    patientId?: string;
    actionSummary?: string;
    confirmationPrompt?: string;
    usage?: { inputTokens: number; outputTokens: number; costEstimate: number; latencyMs: number };
  } = { actionTaken: false },
) {
  const aiProvider = {
    interpretIntent: vi.fn().mockResolvedValue(intentResult),
    generateResponse: vi.fn().mockResolvedValue({ message: 'Olá, tudo bem? 😊', usage }),
  };
  const auditService = { recordAll: vi.fn().mockResolvedValue(undefined) };
  const intentActionRouter = { route: vi.fn().mockResolvedValue(routerResult) };
  const contactIntentActionRouter = { route: vi.fn().mockResolvedValue(contactRouterResult) };
  const metrics = new MetricsService();
  const useCase = new ProcessarMensagemUseCase(aiProvider, auditService, intentActionRouter, contactIntentActionRouter, metrics);
  return { useCase, aiProvider, auditService, intentActionRouter, contactIntentActionRouter, metrics };
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

  describe('ADR-0055 (AD-018), Fase 7 — integração com ContactIntentActionRouter', () => {
    it('sem contactId no input, nunca chama ContactIntentActionRouter (retrocompatível)', async () => {
      const { useCase, contactIntentActionRouter } = makeUseCase({ intent: 'duvida_geral', confidence: 0.9, entities: {}, requiresEscalation: false });
      await useCase.execute({ tenantId: 't1', conversationHistory: [], message: 'oi' });
      expect(contactIntentActionRouter.route).not.toHaveBeenCalled();
    });

    it('com contactId, chama ContactIntentActionRouter com tenantId/contactId/knownPatientId/correlationId', async () => {
      const { useCase, contactIntentActionRouter } = makeUseCase({ intent: 'duvida_geral', confidence: 0.9, entities: {}, requiresEscalation: false });
      await useCase.execute({ tenantId: 't1', patientId: 'p-existente', contactId: 'c1', conversationHistory: [], message: 'oi', correlationId: 'corr-1' });
      expect(contactIntentActionRouter.route).toHaveBeenCalledWith({
        tenantId: 't1',
        contactId: 'c1',
        conversationHistory: [],
        message: 'oi',
        knownPatientId: 'p-existente',
        correlationId: 'corr-1',
      });
    });

    it('um patientId RESOLVIDO pelo ContactIntentActionRouter (promoção) é usado no roteamento de intent desta mesma mensagem', async () => {
      const { useCase, intentActionRouter } = makeUseCase(
        { intent: 'agendar_consulta', confidence: 0.9, entities: { therapistId: 'th1', scheduledAt: '2026-08-10T10:00:00.000Z' }, requiresEscalation: false },
        { actionTaken: false },
        undefined,
        { decision: 'PROMOVER', actionTaken: true, patientId: 'patient-recem-criado', actionSummary: 'Cadastro de Maria realizado com sucesso.' },
      );

      await useCase.execute({ tenantId: 't1', contactId: 'c1', conversationHistory: [], message: 'quero agendar minha primeira consulta' });

      expect(intentActionRouter.route).toHaveBeenCalledWith(expect.anything(), { tenantId: 't1', patientId: 'patient-recem-criado' });
    });

    it('actionTaken=true quando só o ContactIntentActionRouter agiu (ex.: promoção sem intent de agendamento na mesma mensagem)', async () => {
      const { useCase } = makeUseCase(
        { intent: 'duvida_geral', confidence: 0.9, entities: {}, requiresEscalation: false },
        { actionTaken: false },
        undefined,
        { decision: 'PROMOVER', actionTaken: true, patientId: 'p-novo', actionSummary: 'Cadastro realizado.' },
      );

      const result = await useCase.execute({ tenantId: 't1', contactId: 'c1', conversationHistory: [], message: 'meu nome é Maria' });

      expect(result.actionTaken).toBe(true);
    });

    it('injeta actionSummary e confirmationPrompt do Contact routing no contexto de generateResponse', async () => {
      const { useCase, aiProvider } = makeUseCase(
        { intent: 'duvida_geral', confidence: 0.9, entities: {}, requiresEscalation: false },
        { actionTaken: false },
        undefined,
        { actionTaken: false, confirmationPrompt: 'Pode confirmar seu nome completo?' },
      );

      await useCase.execute({ tenantId: 't1', contactId: 'c1', conversationHistory: [], message: 'quero agendar' });

      const callArg = aiProvider.generateResponse.mock.calls[0][0];
      const injected = callArg.conversationHistory.map((m: { content: string }) => m.content).join(' | ');
      expect(injected).toContain('Pode confirmar seu nome completo?');
    });

    it('RNF-021: soma o custo de interpretIntent + ContactIntentClassifier + generateResponse antes de checar o teto', async () => {
      const { useCase, auditService } = makeUseCase(
        {
          intent: 'duvida_geral',
          confidence: 0.9,
          entities: {},
          requiresEscalation: false,
          usage: { inputTokens: 100, outputTokens: 50, costEstimate: 0.01, latencyMs: 100 },
        },
        { actionTaken: false },
        { inputTokens: 500, outputTokens: 150, costEstimate: 0.02, latencyMs: 800 },
        { actionTaken: false, usage: { inputTokens: 80, outputTokens: 20, costEstimate: 0.005, latencyMs: 200 } },
      );

      await useCase.execute({ tenantId: 't1', contactId: 'c1', conversationHistory: [], message: 'oi' });

      const [[events]] = auditService.recordAll.mock.calls;
      // 0.01 (interpretIntent) + 0.005 (ContactIntentClassifier) + 0.02 (generateResponse) = 0.035
      expect((events[0] as { costEstimate: number }).costEstimate).toBeCloseTo(0.035, 5);
    });
  });

  describe('ADR-0055 (AD-018), Fase 8.2 — correlationId e métricas', () => {
    it('repassa correlationId para interpretIntent() e generateResponse()', async () => {
      const { useCase, aiProvider } = makeUseCase({ intent: 'duvida_geral', confidence: 0.9, entities: {}, requiresEscalation: false });
      await useCase.execute({ tenantId: 't1', conversationHistory: [], message: 'oi', correlationId: 'corr-turno' });

      expect(aiProvider.interpretIntent).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'corr-turno' }));
      expect(aiProvider.generateResponse).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'corr-turno' }));
    });

    it('observa conversation_turn_cost_brl com o custo total somado', async () => {
      const { useCase, metrics } = makeUseCase(
        { intent: 'duvida_geral', confidence: 0.9, entities: {}, requiresEscalation: false, usage: { inputTokens: 100, outputTokens: 50, costEstimate: 0.01, latencyMs: 100 } },
        { actionTaken: false },
        { inputTokens: 500, outputTokens: 150, costEstimate: 0.02, latencyMs: 800 },
      );
      await useCase.execute({ tenantId: 't1', conversationHistory: [], message: 'oi' });

      const stats = metrics.getObservationStats('conversation_turn_cost_brl');
      expect(stats?.count).toBe(1);
      expect(stats?.sum).toBeCloseTo(0.03, 5);
    });

    it('observa conversation_turn_duration_ms e incrementa conversation_turns_total', async () => {
      const { useCase, metrics } = makeUseCase({ intent: 'agendar_consulta', confidence: 0.9, entities: {}, requiresEscalation: false });
      await useCase.execute({ tenantId: 't1', conversationHistory: [], message: 'oi' });

      expect(metrics.getObservationStats('conversation_turn_duration_ms')?.count).toBe(1);
      expect(metrics.getCounter('conversation_turns_total', { requires_escalation: false, action_taken: false })).toBe(1);
    });

    it('turno escalonado incrementa conversation_turns_total{requires_escalation=true}', async () => {
      const { useCase, metrics } = makeUseCase({
        intent: 'outro',
        confidence: 0.3,
        entities: {},
        requiresEscalation: true,
        escalationReason: 'sensível',
      });
      await useCase.execute({ tenantId: 't1', conversationHistory: [], message: 'não sei se aguento' });

      expect(metrics.getCounter('conversation_turns_total', { requires_escalation: true, action_taken: false })).toBe(1);
    });
  });
});
