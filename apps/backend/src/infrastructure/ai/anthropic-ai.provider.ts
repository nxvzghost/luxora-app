import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  IAIProvider,
  ConversationInput,
  ConversationContext,
  IntentResult,
  AIResponse,
} from '@domain-services/ai/ai-provider';
import { buildSystemPrompt } from '@use-cases/ai/system-prompt.builder';
import { ClinicRepository, CLINIC_REPOSITORY } from '@domain-services/platform/clinic.repository';
import { THERAPIST_REPOSITORY, TherapistRepository } from '@domain-services/platform/therapist.repository';
import { MetricsService } from '@shared/metrics.service';

type CallType = 'interpretIntent' | 'generateResponse';
const PROVIDER_LABEL = 'anthropic_ai';

/** Erro de HTTP com status — permite distinguir 4xx (não repetível) de 5xx (repetível). Mesma classe (duplicada de propósito) de AnthropicContactIntentClassifier — cada provider Anthropic isolado, nenhuma dependência cruzada entre infraestruturas. */
class AnthropicHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AnthropicHttpError';
  }
}

/**
 * AnthropicAIProvider — Módulo 12.
 * Fonte: 02 - CTO/clinicos/docs/05-IA/00-Provedor-e-Interface.md.
 *
 * Modelo: claude-haiku-4-5-20251001. NÃO TESTADO CONTRA A API REAL — sem
 * rede neste ambiente, mesma categoria de pendência do
 * WhatsAppMessageProvider (Módulo 11).
 *
 * DÍVIDA FECHADA NA REVISÃO GERAL: buildSystemPrompt() usava
 * clinicName/therapistNames fixos — agora busca de verdade via
 * ClinicRepository/TherapistRepository.
 *
 * ADR-0055 (AD-018), Fase 8.1 — hardening: timeout (8s, configurável via
 * `AI_PROVIDER_TIMEOUT_MS`) + retry (até 2 tentativas, só em falha de
 * rede/timeout/5xx, nunca 4xx nem corpo malformado numa resposta 2xx),
 * isolado inteiramente em `callApiWithRetry()`/`callApi()`.
 *
 * Fase 8.2 — observabilidade: `MetricsService` (contadores/observações em
 * memória, sem Prometheus/OTel — ver shared/metrics.service.ts) registra
 * chamadas/duração/retries/timeouts/custo por `call_type`; `correlationId`
 * agora existe em `ConversationInput`/`ConversationContext` (extensão
 * ADITIVA autorizada nesta fase — Fase 8.1 deliberadamente não a fez),
 * propagado no header `X-Correlation-Id` e nos logs, mesmo padrão já
 * usado por AnthropicContactIntentClassifier/WhatsAppMessageProvider.
 * `usage`/`estimateCost()`/o restante do contrato público permanecem
 * inalterados.
 */
@Injectable()
export class AnthropicAIProvider implements IAIProvider {
  private readonly logger = new Logger(AnthropicAIProvider.name);
  private readonly apiUrl = 'https://api.anthropic.com/v1/messages';
  private readonly model = process.env.AI_MODEL ?? 'claude-haiku-4-5-20251001';
  private readonly maxAttempts = 2;
  private readonly timeoutMs = Number(process.env.AI_PROVIDER_TIMEOUT_MS ?? 8000);

  constructor(
    @Inject(CLINIC_REPOSITORY) private readonly clinicRepo: ClinicRepository,
    @Inject(THERAPIST_REPOSITORY) private readonly therapistRepo: TherapistRepository,
    private readonly metrics: MetricsService,
  ) {}

  async interpretIntent(input: ConversationInput): Promise<IntentResult> {
    const systemPrompt = `Você identifica a intenção de mensagens de pacientes para uma clínica de saúde mental.
Responda APENAS com um JSON válido, sem texto adicional, no formato:
{"intent": string, "confidence": number (0-1), "entities": object, "requiresEscalation": boolean, "escalationReason": string opcional}

Intents possíveis: agendar_consulta, remarcar_consulta, cancelar_consulta, confirmar_presenca, consultar_cobranca, consultar_disponibilidade, enviar_comprovante, duvida_geral, outro.

Critério de escalonamento: requiresEscalation=true quando a mensagem envolver algo emocionalmente delicado, ambíguo, ou qualquer situação que fuja do administrativo linear (agendar/cancelar/confirmar/consultar sem conflito).`;

    const start = Date.now();
    const { text, usage } = await this.callApiWithRetry(
      systemPrompt,
      input.conversationHistory,
      input.message,
      300,
      'interpretIntent',
      input.correlationId,
    );
    // ADR-0055 (AD-018), Fase 7 — RNF-021: usage/custo desta chamada não
    // era capturado antes (só generateResponse() era somado ao teto) —
    // agora ProcessarMensagemUseCase soma os três custos possíveis do
    // turno (interpretIntent + ContactIntentClassifier + generateResponse).
    const usageMetrics = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costEstimate: this.estimateCost(usage.inputTokens, usage.outputTokens),
      latencyMs: Date.now() - start,
    };

    try {
      const parsed = JSON.parse(text) as IntentResult;
      return {
        intent: parsed.intent,
        confidence: parsed.confidence,
        entities: parsed.entities ?? {},
        requiresEscalation: parsed.requiresEscalation,
        escalationReason: parsed.escalationReason,
        usage: usageMetrics,
      };
    } catch {
      // Nunca decide sozinho quando nem consegue interpretar a própria
      // resposta — escala por segurança em vez de assumir um intent errado.
      return {
        intent: 'outro',
        confidence: 0,
        entities: {},
        requiresEscalation: true,
        escalationReason: 'Falha ao interpretar resposta do modelo.',
        usage: usageMetrics,
      };
    }
  }

  async generateResponse(context: ConversationContext): Promise<AIResponse> {
    const start = Date.now();

    const clinic = await this.clinicRepo.findByTenantId(context.tenantId);
    const allTherapists = await this.therapistRepo.findAllByTenant();

    const systemPrompt = buildSystemPrompt({
      clinicName: clinic?.name ?? 'Clínica',
      therapistNames: allTherapists.map((t) => t.name),
    });

    const lastMessage = context.conversationHistory[context.conversationHistory.length - 1]?.content ?? '';
    const { text, usage } = await this.callApiWithRetry(
      systemPrompt,
      context.conversationHistory.slice(0, -1),
      lastMessage,
      500,
      'generateResponse',
      context.correlationId,
    );

    return {
      message: text,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costEstimate: this.estimateCost(usage.inputTokens, usage.outputTokens),
        latencyMs: Date.now() - start,
      },
    };
  }

  /**
   * Fase 8.1 — envelope de retry em torno de callApi(): só repete em
   * falha de rede/timeout/5xx; um 4xx (ou corpo malformado numa resposta
   * 2xx — ver callApi()) nunca é repetido, pois o mesmo request falharia
   * de novo do mesmo jeito. Esgotadas as tentativas, lança — o chamador
   * (interpretIntent()/generateResponse(), e por extensão
   * ProcessarMensagemUseCase) não muda: já propagava qualquer erro de
   * callApi() antes desta Fase, continua propagando agora.
   *
   * Fase 8.2 — registra métricas de chamada/duração/custo (sucesso),
   * retries e timeouts (falha), sempre rotuladas por `call_type` — nunca
   * por correlationId/tenantId (cardinalidade ilimitada, ver
   * MetricsService).
   */
  private async callApiWithRetry(
    systemPrompt: string,
    history: ConversationInput['conversationHistory'],
    message: string,
    maxTokens: number,
    callType: CallType,
    correlationId?: string,
  ): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
    let lastError: Error = new Error('Nenhuma tentativa executada.');
    const start = Date.now();
    const labels = { provider: PROVIDER_LABEL, call_type: callType };

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const result = await this.callApi(systemPrompt, history, message, maxTokens, correlationId);
        this.metrics.incrementCounter('ai_provider_calls_total', { ...labels, outcome: 'success' });
        this.metrics.observe('ai_provider_call_duration_ms', Date.now() - start, labels);
        this.metrics.observe(
          'ai_provider_cost_brl',
          this.estimateCost(result.usage.inputTokens, result.usage.outputTokens),
          labels,
        );
        return result;
      } catch (err) {
        lastError = err as Error;
        const isTimeout = lastError.message.startsWith('Timeout de');
        if (isTimeout) {
          this.metrics.incrementCounter('ai_provider_timeouts_total', labels);
        }
        const retryable = !(err instanceof AnthropicHttpError) || err.status >= 500;
        this.logger.warn(
          `[correlationId=${correlationId ?? 'desconhecido'}] Tentativa ${attempt}/${this.maxAttempts} de chamada à Anthropic API (${callType}) falhou (${retryable ? 'repetível' : 'não repetível'}): ${lastError.message}`,
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
    history: ConversationInput['conversationHistory'],
    message: string,
    maxTokens: number,
    correlationId?: string,
  ): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY é obrigatório (.env.example).');
    }

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
          // WhatsAppMessageProvider.send()/AnthropicContactIntentClassifier.
          ...(correlationId ? { 'X-Correlation-Id': correlationId } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [...history, { role: 'user', content: message }],
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
        // recebida e billada por completo do lado da Anthropic). Mesmo
        // tratamento de AnthropicContactIntentClassifier.callApi(): reusa
        // AnthropicHttpError com o status real (2xx, sempre <500), caindo
        // automaticamente no ramo não-repetível do retry.
        throw new AnthropicHttpError(response.status, `Corpo de resposta ilegível (${response.status}): ${(parseErr as Error).message}`);
      }

      const text = data.content.find((c) => c.type === 'text')?.text ?? '';
      return { text, usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens } };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Timeout de ${this.timeoutMs}ms ao chamar Anthropic API.`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /** RNF-021 — teto de referência R$ 0,25/conversa. Preços em USD/1M tokens, câmbio R$ 5,50. */
  private estimateCost(inputTokens: number, outputTokens: number): number {
    const inputCostUsd = (inputTokens / 1_000_000) * 1.0;
    const outputCostUsd = (outputTokens / 1_000_000) * 5.0;
    return (inputCostUsd + outputCostUsd) * 5.5;
  }
}
