import { Injectable, Inject } from '@nestjs/common';
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
 */
@Injectable()
export class AnthropicAIProvider implements IAIProvider {
  private readonly apiUrl = 'https://api.anthropic.com/v1/messages';
  private readonly model = process.env.AI_MODEL ?? 'claude-haiku-4-5-20251001';

  constructor(
    @Inject(CLINIC_REPOSITORY) private readonly clinicRepo: ClinicRepository,
    @Inject(THERAPIST_REPOSITORY) private readonly therapistRepo: TherapistRepository,
  ) {}

  async interpretIntent(input: ConversationInput): Promise<IntentResult> {
    const systemPrompt = `Você identifica a intenção de mensagens de pacientes para uma clínica de saúde mental.
Responda APENAS com um JSON válido, sem texto adicional, no formato:
{"intent": string, "confidence": number (0-1), "entities": object, "requiresEscalation": boolean, "escalationReason": string opcional}

Intents possíveis: agendar_consulta, remarcar_consulta, cancelar_consulta, confirmar_presenca, consultar_cobranca, enviar_comprovante, duvida_geral, outro.

Critério de escalonamento: requiresEscalation=true quando a mensagem envolver algo emocionalmente delicado, ambíguo, ou qualquer situação que fuja do administrativo linear (agendar/cancelar/confirmar/consultar sem conflito).`;

    const { text } = await this.callApi(systemPrompt, input.conversationHistory, input.message, 300);

    try {
      const parsed = JSON.parse(text) as IntentResult;
      return {
        intent: parsed.intent,
        confidence: parsed.confidence,
        entities: parsed.entities ?? {},
        requiresEscalation: parsed.requiresEscalation,
        escalationReason: parsed.escalationReason,
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
    const { text, usage } = await this.callApi(
      systemPrompt,
      context.conversationHistory.slice(0, -1),
      lastMessage,
      500,
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

  private async callApi(
    systemPrompt: string,
    history: ConversationInput['conversationHistory'],
    message: string,
    maxTokens: number,
  ): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY é obrigatório (.env.example).');
    }

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [...history, { role: 'user', content: message }],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Falha ao chamar Anthropic API (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };

    const text = data.content.find((c) => c.type === 'text')?.text ?? '';
    return { text, usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens } };
  }

  /** RNF-021 — teto de referência R$ 0,25/conversa. Preços em USD/1M tokens, câmbio R$ 5,50. */
  private estimateCost(inputTokens: number, outputTokens: number): number {
    const inputCostUsd = (inputTokens / 1_000_000) * 1.0;
    const outputCostUsd = (outputTokens / 1_000_000) * 5.0;
    return (inputCostUsd + outputCostUsd) * 5.5;
  }
}
