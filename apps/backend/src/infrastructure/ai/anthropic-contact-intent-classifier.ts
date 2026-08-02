import { Injectable, Logger } from '@nestjs/common';
import {
  ContactIntentClassifier,
  ContactIntentClassificationInput,
  ContactIntentClassificationResult,
} from '@domain-services/ai/contact-intent-classifier';
import { buildContactIntentPrompt } from '@use-cases/ai/contact-intent-prompt-builder';
import { parseContactIntentResponse } from '@use-cases/ai/contact-intent-response-parser';
import { MetricsService } from '@shared/metrics.service';

const PROVIDER_LABEL = 'contact_classifier';
const CALL_TYPE_LABEL = 'classify';

/** Erro de HTTP com status — permite distinguir 4xx (não repetível: o mesmo request falharia de novo) de 5xx (repetível). */
class AnthropicHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AnthropicHttpError';
  }
}

/**
 * AnthropicContactIntentClassifier — ADR-0055 (AD-018).
 *
 * Fase 6: implementação real criada por completude da arquitetura, ainda
 * não registrada em nenhum @Module nem exercitada por teste.
 *
 * Fase 7: prompt/parser extraídos para contact-intent-prompt-builder.ts/
 * contact-intent-response-parser.ts (melhoria opcional sugerida na
 * aprovação da Fase 6); adiciona timeout + retry (nenhum padrão
 * equivalente existia em nenhum outro provider deste projeto — construído
 * aqui, escopado só a este classificador, sem tocar
 * AnthropicAIProvider/WhatsAppMessageProvider/AsaasPaymentProvider);
 * thread correlationId no header de saída (mesmo padrão de
 * WhatsAppMessageProvider.send()) e nos logs (mesmo formato
 * `[correlationId=...]` de WhatsAppInboundQueueWorker); calcula
 * `usage`/custo com a MESMA fórmula de AnthropicAIProvider.estimateCost()
 * (RNF-021) — agora este classificador tem seu custo real somado ao
 * teto de R$0,25/conversa em ProcessarMensagemUseCase, nunca mais
 * invisível.
 *
 * Retry só em falhas de rede/timeout/5xx — um 4xx (ex.: corpo malformado)
 * falharia de novo do mesmo jeito, retry só gastaria custo à toa.
 * Esgotadas as tentativas, lança — o chamador (ContactIntentActionRouter)
 * já converte qualquer exceção em `{decision:'HUMANO', escalateToHuman:true}`
 * de forma seguro (Fase 6, já testado), nunca duplicando essa lógica aqui.
 */
@Injectable()
export class AnthropicContactIntentClassifier implements ContactIntentClassifier {
  private readonly logger = new Logger(AnthropicContactIntentClassifier.name);
  private readonly apiUrl = 'https://api.anthropic.com/v1/messages';
  private readonly model = process.env.AI_MODEL ?? 'claude-haiku-4-5-20251001';
  private readonly maxAttempts = 2;
  private readonly timeoutMs = Number(process.env.CONTACT_CLASSIFIER_TIMEOUT_MS ?? 8000);

  constructor(private readonly metrics: MetricsService) {}

  async classify(input: ContactIntentClassificationInput): Promise<ContactIntentClassificationResult> {
    const systemPrompt = buildContactIntentPrompt(input);
    const { text, usage } = await this.callApiWithRetry(systemPrompt, input);
    const parsed = parseContactIntentResponse(text);
    return { ...parsed, usage };
  }

  /** Fase 8.2 — mesma instrumentação de MetricsService já aplicada em AnthropicAIProvider.callApiWithRetry(), mesmos nomes de métrica (provider='contact_classifier' distingue este classificador). */
  private async callApiWithRetry(
    systemPrompt: string,
    input: ContactIntentClassificationInput,
  ): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number; costEstimate: number; latencyMs: number } }> {
    let lastError: Error = new Error('Nenhuma tentativa executada.');
    const start = Date.now();
    const labels = { provider: PROVIDER_LABEL, call_type: CALL_TYPE_LABEL };

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const result = await this.callApi(systemPrompt, input);
        this.metrics.incrementCounter('ai_provider_calls_total', { ...labels, outcome: 'success' });
        this.metrics.observe('ai_provider_call_duration_ms', Date.now() - start, labels);
        this.metrics.observe('ai_provider_cost_brl', result.usage.costEstimate, labels);
        return result;
      } catch (err) {
        lastError = err as Error;
        const isTimeout = lastError.message.startsWith('Timeout de');
        if (isTimeout) {
          this.metrics.incrementCounter('ai_provider_timeouts_total', labels);
        }
        const retryable = !(err instanceof AnthropicHttpError) || err.status >= 500;
        this.logger.warn(
          `[correlationId=${input.correlationId ?? 'desconhecido'}] Tentativa ${attempt}/${this.maxAttempts} de classificação de Contact falhou (${retryable ? 'repetível' : 'não repetível'}): ${lastError.message}`,
        );
        if (!retryable || attempt === this.maxAttempts) {
          this.metrics.incrementCounter('ai_provider_calls_total', { ...labels, outcome: isTimeout ? 'timeout' : 'error' });
          throw lastError;
        }
        this.metrics.incrementCounter('ai_provider_retries_total', labels);
      }
    }

    throw lastError;
  }

  private async callApi(
    systemPrompt: string,
    input: ContactIntentClassificationInput,
  ): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number; costEstimate: number; latencyMs: number } }> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY é obrigatório (.env.example).');
    }

    const start = Date.now();
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          // AD-016 — correlaciona esta chamada externa com o restante dos
          // logs do job/requisição de origem, mesmo padrão já usado por
          // WhatsAppMessageProvider.send(). Ausente quando input não trouxe
          // um (nunca bloqueia a classificação por isso).
          ...(input.correlationId ? { 'X-Correlation-Id': input.correlationId } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 200,
          system: systemPrompt,
          messages: [...input.conversationHistory, { role: 'user', content: input.message }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new AnthropicHttpError(response.status, `Falha ao chamar Anthropic API (${response.status}): ${errorBody}`);
      }

      let data: { content: Array<{ type: string; text?: string }>; usage: { input_tokens: number; output_tokens: number } };
      try {
        data = await response.json();
      } catch (parseErr) {
        // Corpo malformado numa resposta 2xx não é timeout, falha de rede
        // nem 5xx — repetir não mudaria o resultado (a resposta já foi
        // recebida e billada por completo do lado da Anthropic). Reusa
        // AnthropicHttpError com o status real (2xx, sempre <500) só para
        // cair automaticamente no ramo "não repetível" do retry, sem
        // precisar de um caso especial separado.
        throw new AnthropicHttpError(response.status, `Corpo de resposta ilegível (${response.status}): ${(parseErr as Error).message}`);
      }
      const text = data.content.find((c) => c.type === 'text')?.text ?? '';

      return {
        text,
        usage: {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
          costEstimate: this.estimateCost(data.usage.input_tokens, data.usage.output_tokens),
          latencyMs: Date.now() - start,
        },
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Timeout de ${this.timeoutMs}ms ao chamar Anthropic API (classificação de Contact).`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /** Mesma fórmula de AnthropicAIProvider.estimateCost() (RNF-021) — preços em USD/1M tokens, câmbio R$ 5,50. */
  private estimateCost(inputTokens: number, outputTokens: number): number {
    const inputCostUsd = (inputTokens / 1_000_000) * 1.0;
    const outputCostUsd = (outputTokens / 1_000_000) * 5.0;
    return (inputCostUsd + outputCostUsd) * 5.5;
  }
}
