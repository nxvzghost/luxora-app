import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicContactIntentClassifier } from '@infrastructure/ai/anthropic-contact-intent-classifier';
import { ContactIntentClassificationInput } from '@domain-services/ai/contact-intent-classifier';

function baseInput(overrides: Partial<ContactIntentClassificationInput> = {}): ContactIntentClassificationInput {
  return {
    tenantId: 't1',
    conversationHistory: [],
    message: 'Olá',
    contactState: 'Identificado',
    associationCount: 0,
    ...overrides,
  };
}

function okResponse(decision: string, usage = { input_tokens: 80, output_tokens: 20 }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ decision, confidence: 0.9 }) }], usage }),
  };
}

describe('AnthropicContactIntentClassifier — ADR-0055 (AD-018), Fase 7', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'fake-key-nunca-sai-da-maquina';
  });

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = '';
    vi.unstubAllGlobals();
  });

  it('classifica com sucesso e calcula usage/custo (RNF-021)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse('IGNORAR'));
    vi.stubGlobal('fetch', fetchMock);

    const classifier = new AnthropicContactIntentClassifier();
    const result = await classifier.classify(baseInput());

    expect(result.decision).toBe('IGNORAR');
    expect(result.usage).toBeDefined();
    expect(result.usage!.inputTokens).toBe(80);
    expect(result.usage!.outputTokens).toBe(20);
    expect(result.usage!.costEstimate).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('inclui X-Correlation-Id no header quando presente', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse('IGNORAR'));
    vi.stubGlobal('fetch', fetchMock);

    const classifier = new AnthropicContactIntentClassifier();
    await classifier.classify(baseInput({ correlationId: 'corr-abc' }));

    const [, options] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(options.headers['X-Correlation-Id']).toBe('corr-abc');
  });

  it('nunca envia X-Correlation-Id quando ausente', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse('IGNORAR'));
    vi.stubGlobal('fetch', fetchMock);

    const classifier = new AnthropicContactIntentClassifier();
    await classifier.classify(baseInput());

    const [, options] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(options.headers['X-Correlation-Id']).toBeUndefined();
  });

  it('retry: uma falha 500 seguida de sucesso classifica normalmente, sem propagar erro', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'erro interno simulado' })
      .mockResolvedValueOnce(okResponse('PROMOVER'));
    vi.stubGlobal('fetch', fetchMock);

    const classifier = new AnthropicContactIntentClassifier();
    const result = await classifier.classify(baseInput());

    expect(result.decision).toBe('PROMOVER');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('nunca repete uma falha 4xx (não repetível) — lança na primeira tentativa', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'corpo inválido' });
    vi.stubGlobal('fetch', fetchMock);

    const classifier = new AnthropicContactIntentClassifier();
    await expect(classifier.classify(baseInput())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('esgota as tentativas em falhas 5xx persistentes e lança (o chamador — Router — converte em HUMANO)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'indisponível' });
    vi.stubGlobal('fetch', fetchMock);

    const classifier = new AnthropicContactIntentClassifier();
    await expect(classifier.classify(baseInput())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2); // MAX_ATTEMPTS = 2
  });

  it('lança quando ANTHROPIC_API_KEY não está configurada', async () => {
    process.env.ANTHROPIC_API_KEY = '';
    const classifier = new AnthropicContactIntentClassifier();
    await expect(classifier.classify(baseInput())).rejects.toThrow('ANTHROPIC_API_KEY');
  });

  it('timeout: aborta e trata como falha repetível (mesma via de retry de um 5xx)', async () => {
    process.env.CONTACT_CLASSIFIER_TIMEOUT_MS = '20';
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
      .mockResolvedValueOnce(okResponse('IGNORAR'));
    vi.stubGlobal('fetch', fetchMock);

    const classifier = new AnthropicContactIntentClassifier();
    const result = await classifier.classify(baseInput());

    expect(result.decision).toBe('IGNORAR');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    delete process.env.CONTACT_CLASSIFIER_TIMEOUT_MS;
  });
});
