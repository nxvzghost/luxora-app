import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicAIProvider } from '@infrastructure/ai/anthropic-ai.provider';
import { ConversationInput, ConversationContext, IntentResult } from '@domain-services/ai/ai-provider';
import { MetricsService } from '@shared/metrics.service';

function baseIntentInput(overrides: Partial<ConversationInput> = {}): ConversationInput {
  return { tenantId: 't1', conversationHistory: [], message: 'Olá', ...overrides };
}

function baseGenerateContext(intent: IntentResult, overrides: Partial<ConversationContext> = {}): ConversationContext {
  return { tenantId: 't1', conversationHistory: [{ role: 'user', content: 'Olá' }], intent, ...overrides };
}

function okIntentResponse(usage = { input_tokens: 100, output_tokens: 40 }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ intent: 'duvida_geral', confidence: 0.8, entities: {}, requiresEscalation: false }) }],
      usage,
    }),
  };
}

function okGenerateResponse(usage = { input_tokens: 200, output_tokens: 80 }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text: 'Olá, tudo bem?' }], usage }),
  };
}

function makeProvider() {
  const clinicRepo = { findByTenantId: vi.fn().mockResolvedValue({ name: 'Clínica Teste' }) };
  const therapistRepo = { findAllByTenant: vi.fn().mockResolvedValue([{ name: 'Dra. Ana' }]) };
  const metrics = new MetricsService();
  const provider = new AnthropicAIProvider(clinicRepo as never, therapistRepo as never, metrics);
  return { provider, clinicRepo, therapistRepo, metrics };
}

describe('AnthropicAIProvider — ADR-0055 (AD-018), Fase 8.1 (hardening)', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'fake-key-nunca-sai-da-maquina';
  });

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = '';
    vi.unstubAllGlobals();
  });

  describe('interpretIntent() — usage/custo preservados', () => {
    it('calcula usage/costEstimate a partir da resposta real (RNF-021 preservado)', async () => {
      const fetchMock = vi.fn().mockResolvedValue(okIntentResponse({ input_tokens: 100, output_tokens: 40 }));
      vi.stubGlobal('fetch', fetchMock);

      const { provider } = makeProvider();
      const result = await provider.interpretIntent(baseIntentInput());

      expect(result.intent).toBe('duvida_geral');
      expect(result.usage).toBeDefined();
      expect(result.usage!.inputTokens).toBe(100);
      expect(result.usage!.outputTokens).toBe(40);
      // (100/1e6*1.0 + 40/1e6*5.0) * 5.5 — mesma fórmula de estimateCost(), inalterada.
      expect(result.usage!.costEstimate).toBeCloseTo((100 / 1_000_000 + (40 / 1_000_000) * 5) * 5.5, 10);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('contrato público de IntentResult permanece inalterado — nenhum campo novo obrigatório', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okIntentResponse()));
      const { provider } = makeProvider();
      const result = await provider.interpretIntent(baseIntentInput());
      // escalationReason sempre presente como chave (valor undefined quando
      // ausente na resposta) — atribuição direta no objeto literal, não uma
      // mudança de contrato desta Fase.
      expect(Object.keys(result).sort()).toEqual(
        ['confidence', 'entities', 'escalationReason', 'intent', 'requiresEscalation', 'usage'].sort(),
      );
    });
  });

  describe('generateResponse() — usage/custo preservados', () => {
    it('calcula usage/costEstimate a partir da resposta real', async () => {
      const fetchMock = vi.fn().mockResolvedValue(okGenerateResponse({ input_tokens: 200, output_tokens: 80 }));
      vi.stubGlobal('fetch', fetchMock);

      const { provider } = makeProvider();
      const intent: IntentResult = { intent: 'duvida_geral', confidence: 0.9, entities: {}, requiresEscalation: false };
      const result = await provider.generateResponse(baseGenerateContext(intent));

      expect(result.message).toBe('Olá, tudo bem?');
      expect(result.usage.inputTokens).toBe(200);
      expect(result.usage.outputTokens).toBe(80);
      expect(result.usage.costEstimate).toBeCloseTo((200 / 1_000_000 + (80 / 1_000_000) * 5) * 5.5, 10);
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  describe('retry — só em falha de rede/timeout/5xx', () => {
    it('uma falha 500 seguida de sucesso resolve normalmente, sem propagar erro', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'erro interno simulado' })
        .mockResolvedValueOnce(okIntentResponse());
      vi.stubGlobal('fetch', fetchMock);

      const { provider } = makeProvider();
      const result = await provider.interpretIntent(baseIntentInput());

      expect(result.intent).toBe('duvida_geral');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('uma falha de rede (fetch rejeitando) seguida de sucesso resolve normalmente', async () => {
      const fetchMock = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET simulado')).mockResolvedValueOnce(okIntentResponse());
      vi.stubGlobal('fetch', fetchMock);

      const { provider } = makeProvider();
      const result = await provider.interpretIntent(baseIntentInput());

      expect(result.intent).toBe('duvida_geral');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('esgota as tentativas em falhas 5xx persistentes e lança', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'indisponível' });
      vi.stubGlobal('fetch', fetchMock);

      const { provider } = makeProvider();
      await expect(provider.interpretIntent(baseIntentInput())).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(2); // maxAttempts = 2
    });

    it('nunca repete uma falha 4xx — lança na primeira tentativa', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'corpo inválido' });
      vi.stubGlobal('fetch', fetchMock);

      const { provider } = makeProvider();
      await expect(provider.interpretIntent(baseIntentInput())).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('nunca repete um corpo malformado numa resposta 2xx', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('JSON inválido'); } });
      vi.stubGlobal('fetch', fetchMock);

      const { provider } = makeProvider();
      await expect(provider.interpretIntent(baseIntentInput())).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('generateResponse() também aplica a mesma política de retry', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'bad gateway simulado' })
        .mockResolvedValueOnce(okGenerateResponse());
      vi.stubGlobal('fetch', fetchMock);

      const { provider } = makeProvider();
      const intent: IntentResult = { intent: 'duvida_geral', confidence: 0.9, entities: {}, requiresEscalation: false };
      const result = await provider.generateResponse(baseGenerateContext(intent));

      expect(result.message).toBe('Olá, tudo bem?');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('timeout — nunca deixa Promise/timer pendurado', () => {
    it('aborta e trata como falha repetível (mesma via de retry de um 5xx)', async () => {
      process.env.AI_PROVIDER_TIMEOUT_MS = '20';
      const fetchMock = vi
        .fn()
        .mockImplementationOnce((_url: string, options: { signal: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted.');
              err.name = 'AbortError';
              reject(err);
            });
          });
        })
        .mockResolvedValueOnce(okIntentResponse());
      vi.stubGlobal('fetch', fetchMock);

      const { provider } = makeProvider();
      const result = await provider.interpretIntent(baseIntentInput());

      expect(result.intent).toBe('duvida_geral');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      delete process.env.AI_PROVIDER_TIMEOUT_MS;
    });
  });

  describe('ANTHROPIC_API_KEY ausente', () => {
    it('lança sem tentar nenhuma chamada de rede', async () => {
      process.env.ANTHROPIC_API_KEY = '';
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const { provider } = makeProvider();
      await expect(provider.interpretIntent(baseIntentInput())).rejects.toThrow('ANTHROPIC_API_KEY');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('ADR-0055 (AD-018), Fase 8.2 — correlationId', () => {
    it('inclui X-Correlation-Id no header quando presente em ConversationInput/ConversationContext', async () => {
      const fetchMock = vi.fn().mockResolvedValue(okIntentResponse());
      vi.stubGlobal('fetch', fetchMock);

      const { provider } = makeProvider();
      await provider.interpretIntent(baseIntentInput({ correlationId: 'corr-xyz' }));

      const [, options] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
      expect(options.headers['X-Correlation-Id']).toBe('corr-xyz');
    });

    it('nunca envia X-Correlation-Id quando ausente', async () => {
      const fetchMock = vi.fn().mockResolvedValue(okIntentResponse());
      vi.stubGlobal('fetch', fetchMock);

      const { provider } = makeProvider();
      await provider.interpretIntent(baseIntentInput());

      const [, options] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
      expect(options.headers['X-Correlation-Id']).toBeUndefined();
    });

    it('generateResponse() também propaga correlationId', async () => {
      const fetchMock = vi.fn().mockResolvedValue(okGenerateResponse());
      vi.stubGlobal('fetch', fetchMock);

      const { provider } = makeProvider();
      const intent: IntentResult = { intent: 'duvida_geral', confidence: 0.9, entities: {}, requiresEscalation: false };
      await provider.generateResponse(baseGenerateContext(intent, { correlationId: 'corr-abc' }));

      const [, options] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
      expect(options.headers['X-Correlation-Id']).toBe('corr-abc');
    });
  });

  describe('ADR-0055 (AD-018), Fase 8.2 — métricas', () => {
    it('sucesso: incrementa ai_provider_calls_total{outcome=success} e observa duração/custo', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okIntentResponse({ input_tokens: 100, output_tokens: 40 })));
      const { provider, metrics } = makeProvider();

      await provider.interpretIntent(baseIntentInput());

      const labels = { provider: 'anthropic_ai', call_type: 'interpretIntent' };
      expect(metrics.getCounter('ai_provider_calls_total', { ...labels, outcome: 'success' })).toBe(1);
      expect(metrics.getObservationStats('ai_provider_call_duration_ms', labels)?.count).toBe(1);
      expect(metrics.getObservationStats('ai_provider_cost_brl', labels)?.count).toBe(1);
    });

    it('erro (4xx, sem retry): incrementa ai_provider_calls_total{outcome=error} uma única vez', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'corpo inválido' }));
      const { provider, metrics } = makeProvider();

      await expect(provider.interpretIntent(baseIntentInput())).rejects.toThrow();

      const labels = { provider: 'anthropic_ai', call_type: 'interpretIntent' };
      expect(metrics.getCounter('ai_provider_calls_total', { ...labels, outcome: 'error' })).toBe(1);
      expect(metrics.getCounter('ai_provider_calls_total', { ...labels, outcome: 'success' })).toBe(0);
    });

    it('timeout: incrementa ai_provider_timeouts_total e, após recuperar via retry, ai_provider_calls_total{outcome=success}', async () => {
      process.env.AI_PROVIDER_TIMEOUT_MS = '20';
      const fetchMock = vi
        .fn()
        .mockImplementationOnce((_url: string, options: { signal: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted.');
              err.name = 'AbortError';
              reject(err);
            });
          });
        })
        .mockResolvedValueOnce(okIntentResponse());
      vi.stubGlobal('fetch', fetchMock);

      const { provider, metrics } = makeProvider();
      await provider.interpretIntent(baseIntentInput());

      const labels = { provider: 'anthropic_ai', call_type: 'interpretIntent' };
      expect(metrics.getCounter('ai_provider_timeouts_total', labels)).toBe(1);
      expect(metrics.getCounter('ai_provider_calls_total', { ...labels, outcome: 'success' })).toBe(1);
      delete process.env.AI_PROVIDER_TIMEOUT_MS;
    });

    it('retry: incrementa ai_provider_retries_total uma vez por nova tentativa', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'erro interno simulado' })
        .mockResolvedValueOnce(okIntentResponse());
      vi.stubGlobal('fetch', fetchMock);

      const { provider, metrics } = makeProvider();
      await provider.interpretIntent(baseIntentInput());

      expect(metrics.getCounter('ai_provider_retries_total', { provider: 'anthropic_ai', call_type: 'interpretIntent' })).toBe(1);
    });

    it('interpretIntent e generateResponse são rotulados por call_type distinto — contadores nunca se misturam', async () => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, options: { body: string }) => {
        const body = JSON.parse(options.body) as { max_tokens: number };
        return body.max_tokens === 300 ? okIntentResponse() : okGenerateResponse();
      }));
      const { provider, metrics } = makeProvider();

      await provider.interpretIntent(baseIntentInput());
      const intent: IntentResult = { intent: 'duvida_geral', confidence: 0.9, entities: {}, requiresEscalation: false };
      await provider.generateResponse(baseGenerateContext(intent));

      expect(metrics.getCounter('ai_provider_calls_total', { provider: 'anthropic_ai', call_type: 'interpretIntent', outcome: 'success' })).toBe(1);
      expect(metrics.getCounter('ai_provider_calls_total', { provider: 'anthropic_ai', call_type: 'generateResponse', outcome: 'success' })).toBe(1);
    });
  });
});
