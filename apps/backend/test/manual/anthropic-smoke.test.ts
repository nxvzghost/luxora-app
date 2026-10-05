import { describe, it, expect } from 'vitest';
import { AnthropicAIProvider } from '@infrastructure/ai/anthropic-ai.provider';
import { AnthropicContactIntentClassifier } from '@infrastructure/ai/anthropic-contact-intent-classifier';
import { ClinicRepository } from '@domain-services/platform/clinic.repository';
import { TherapistRepository } from '@domain-services/platform/therapist.repository';
import { MetricsService } from '@shared/metrics.service';
import { loadBackendEnv, logSmoke } from './support/smoke-env';

/**
 * [MANUAL] Chamada real à API da Anthropic — as 3 chamadas de um turno
 * (interpretIntent, ContactIntentClassifier, generateResponse), pelos
 * providers reais. Custa centavos de dólar por execução.
 *
 * Só roda com ANTHROPIC_SMOKE=1 e ANTHROPIC_API_KEY definidos; sem isso o
 * arquivo inteiro é pulado. Ver test/manual/README.md.
 *
 * TODO O CONTEÚDO É SINTÉTICO: clínica, terapeutas e mensagens abaixo são
 * inventados. Nenhum banco é lido — os repositórios são objetos em
 * memória —, então nenhum dado de clínica ou paciente real sai da máquina.
 */
loadBackendEnv();

const enabled = process.env.ANTHROPIC_SMOKE === '1' && Boolean(process.env.ANTHROPIC_API_KEY);

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const MESSAGE = 'Olá, gostaria de saber quais horários vocês têm na quinta-feira à tarde.';

describe.skipIf(!enabled)('[MANUAL] Anthropic — turno completo com conteúdo sintético', () => {
  const metrics = new MetricsService();
  const clinicRepo = { findByTenantId: async () => ({ name: 'Clínica Exemplo (teste de integração)' }) } as unknown as ClinicRepository;
  const therapistRepo = {
    findAllByTenant: async () => [{ name: 'Terapeuta Fictícia Um' }, { name: 'Terapeuta Fictício Dois' }],
  } as unknown as TherapistRepository;
  const provider = new AnthropicAIProvider(clinicRepo, therapistRepo, metrics);
  const classifier = new AnthropicContactIntentClassifier(metrics);
  const model = process.env.AI_MODEL ?? 'claude-haiku-4-5-20251001';

  it('interpretIntent devolve um intent interpretável (o JSON do modelo real é lido pelo parser)', async () => {
    const result = await provider.interpretIntent({
      tenantId: TENANT_ID,
      conversationHistory: [],
      message: MESSAGE,
      correlationId: 'smoke-anthropic-intent',
    });

    logSmoke('anthropic', {
      chamada: 'interpretIntent',
      modelo: model,
      intent: result.intent,
      escalar: result.requiresEscalation,
      tokens_entrada: result.usage?.inputTokens,
      tokens_saida: result.usage?.outputTokens,
      latencia_ms: result.usage?.latencyMs,
      custo_brl: result.usage?.costEstimate.toFixed(5),
    });

    // Se o modelo real embrulhar o JSON (cercas de código, texto em volta),
    // o provider cai no ramo de segurança com este motivo — é exatamente o
    // defeito que só uma chamada real revela.
    expect(result.escalationReason).not.toBe('Falha ao interpretar resposta do modelo.');
    expect(typeof result.intent).toBe('string');
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
  }, 30000);

  it('ContactIntentClassifier devolve uma decisão válida', async () => {
    const result = await classifier.classify({
      tenantId: TENANT_ID,
      conversationHistory: [],
      message: MESSAGE,
      contactState: 'Novo',
      associationCount: 0,
      correlationId: 'smoke-anthropic-contact',
    });

    logSmoke('anthropic', {
      chamada: 'contactClassifier',
      modelo: model,
      decisao: result.decision,
      tokens_entrada: result.usage?.inputTokens,
      tokens_saida: result.usage?.outputTokens,
      latencia_ms: result.usage?.latencyMs,
      custo_brl: result.usage?.costEstimate.toFixed(5),
    });

    expect(['PROMOVER', 'ASSOCIAR', 'DESAMBIGUAR', 'IGNORAR', 'HUMANO']).toContain(result.decision);
  }, 30000);

  it('generateResponse devolve texto e uso de tokens', async () => {
    const result = await provider.generateResponse({
      tenantId: TENANT_ID,
      conversationHistory: [{ role: 'user', content: MESSAGE }],
      intent: { intent: 'consultar_disponibilidade', confidence: 0.9, entities: {}, requiresEscalation: false },
      correlationId: 'smoke-anthropic-response',
    });

    logSmoke('anthropic', {
      chamada: 'generateResponse',
      modelo: model,
      caracteres_resposta: result.message.length,
      tokens_entrada: result.usage.inputTokens,
      tokens_saida: result.usage.outputTokens,
      latencia_ms: result.usage.latencyMs,
      custo_brl: result.usage.costEstimate.toFixed(5),
    });

    expect(result.message.length).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  }, 30000);
});
