import { describe, it, expect } from 'vitest';
import { AnthropicAIProvider } from '@infrastructure/ai/anthropic-ai.provider';
import { ClinicRepository } from '@domain-services/platform/clinic.repository';
import { TherapistRepository } from '@domain-services/platform/therapist.repository';
import type { AppointmentContextForAi, IntentResult } from '@domain-services/ai/ai-provider';
import { MetricsService } from '@shared/metrics.service';
import { loadBackendEnv, logSmoke } from './support/smoke-env';

/**
 * [MANUAL / EXTERNAL] K11 — a classificação da resposta do paciente pelo modelo
 * real (interpretIntent com e sem pergunta pendente). Cinco chamadas, uma por
 * caso, sem nenhuma outra chamada do turno. Custa frações de centavo.
 *
 * Só roda com ANTHROPIC_SMOKE=1 e ANTHROPIC_API_KEY definidos. Ver
 * test/manual/README.md.
 *
 * TODO O CONTEÚDO É SINTÉTICO. Nenhum banco, fila ou WhatsApp é tocado; o log
 * registra só metadados (esperado, obtido, tokens, latência, custo), nunca o
 * texto das mensagens.
 */
loadBackendEnv();

const enabled = process.env.ANTHROPIC_SMOKE === '1' && Boolean(process.env.ANTHROPIC_API_KEY);

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const QUESTION =
  'Você quer cancelar a consulta de sexta-feira, 30/10, às 14:00, com Terapeuta Fictícia Um? Responda sim para confirmar.';
const CONTEXT: AppointmentContextForAi = {
  today: '2026-10-27 (terça-feira)',
  upcoming: [{ date: '2026-10-30', weekday: 'sexta-feira', time: '14:00', professional: 'Terapeuta Fictícia Um', modality: 'presencial' }],
};

interface Case {
  name: string;
  message: string;
  pending: boolean;
  expectedConfirmation?: 'confirma' | 'recusa' | 'ambigua';
}

const CASES: Case[] = [
  { name: '0-pedido', message: 'Preciso cancelar minha consulta de sexta.', pending: false },
  { name: '1-confirma', message: 'Sim, pode cancelar.', pending: true, expectedConfirmation: 'confirma' },
  { name: '2-recusa', message: 'Não, deixa como está.', pending: true, expectedConfirmation: 'recusa' },
  { name: '3-ambigua', message: 'Acho que sim, mas não tenho certeza.', pending: true, expectedConfirmation: 'ambigua' },
  { name: '4-ressalva', message: 'Sim, pode cancelar, mas só se eu conseguir remarcar pra semana que vem.', pending: true, expectedConfirmation: 'ambigua' },
];

describe.skipIf(!enabled)('[MANUAL / EXTERNAL] Anthropic — K11, classificação da resposta (conteúdo sintético)', () => {
  const metrics = new MetricsService();
  const clinicRepo = { findByTenantId: async () => ({ name: 'Clínica Exemplo (teste de integração)' }) } as unknown as ClinicRepository;
  const therapistRepo = { findAllByTenant: async () => [{ name: 'Terapeuta Fictícia Um' }] } as unknown as TherapistRepository;
  const provider = new AnthropicAIProvider(clinicRepo, therapistRepo, metrics);
  // Uma tentativa por caso: o provider repete sozinho em timeout/5xx, e este
  // smoke não pode passar de cinco requisições. (Só neste teste; a produção
  // não é alterada.)
  (provider as unknown as { maxAttempts: number }).maxAttempts = 1;
  const model = process.env.AI_MODEL ?? 'claude-haiku-4-5-20251001';

  for (const c of CASES) {
    it(`${c.name}`, async () => {
      let result: IntentResult;
      try {
        result = await provider.interpretIntent({
          tenantId: TENANT_ID,
          conversationHistory: [],
          message: c.message,
          correlationId: `smoke-anthropic-k11-${c.name}`,
          appointmentContext: c.pending ? { ...CONTEXT, pendingQuestion: QUESTION } : CONTEXT,
        });
      } catch (err) {
        const message = (err as Error).message ?? '';
        logSmoke('anthropic-k11', {
          caso: c.name,
          modelo: model,
          resultado: message.startsWith('Timeout de') ? 'TIMEOUT' : 'ERRO_DA_API',
          detalhe: message.replace(/\s+/g, '_').slice(0, 80),
        });
        throw err;
      }

      const parseFailed = result.escalationReason === 'Falha ao interpretar resposta do modelo.';
      const entities = result.entities as Record<string, unknown>;
      logSmoke('anthropic-k11', {
        caso: c.name,
        modelo: model,
        esperado: c.expectedConfirmation ?? 'cancelar_consulta+2026-10-30',
        obtido_confirmation: result.confirmation ?? 'ausente',
        obtido_intent: result.intent,
        escalar: result.requiresEscalation,
        data_extraida: entities?.appointmentDate === '2026-10-30',
        falha_de_leitura_do_json: parseFailed,
        tokens_entrada: result.usage?.inputTokens,
        tokens_saida: result.usage?.outputTokens,
        latencia_ms: result.usage?.latencyMs,
        custo_brl: result.usage?.costEstimate.toFixed(5),
      });

      expect(parseFailed).toBe(false);
      if (c.expectedConfirmation) {
        // Critério crítico: confirma executa o cancelamento; a ressalva nunca pode virar confirma.
        if (c.name === '4-ressalva') expect(result.confirmation).not.toBe('confirma');
        expect(result.confirmation).toBe(c.expectedConfirmation);
      } else {
        expect(result.intent).toBe('cancelar_consulta');
        expect(result.confirmation).toBeUndefined();
        expect(entities?.appointmentDate).toBe('2026-10-30');
      }
    }, 30000);
  }
});
