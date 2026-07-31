import { describe, it, expect } from 'vitest';
import { buildContactIntentPrompt } from '@use-cases/ai/contact-intent-prompt-builder';

describe('buildContactIntentPrompt — ADR-0055 (AD-018), Fase 7', () => {
  it('inclui o estado atual do Contact e a contagem de associações', () => {
    const prompt = buildContactIntentPrompt({ contactState: 'Identificado', associationCount: 2 });
    expect(prompt).toContain('"Identificado"');
    expect(prompt).toContain('2');
  });

  it('lista as 5 decisões possíveis, exatamente o vocabulário do classificador', () => {
    const prompt = buildContactIntentPrompt({ contactState: 'Novo', associationCount: 0 });
    for (const decision of ['PROMOVER', 'ASSOCIAR', 'DESAMBIGUAR', 'HUMANO', 'IGNORAR']) {
      expect(prompt).toContain(decision);
    }
  });

  it('nunca menciona intents de agendamento/cobrança — eixo de classificação separado', () => {
    const prompt = buildContactIntentPrompt({ contactState: 'Novo', associationCount: 0 });
    expect(prompt).not.toContain('agendar_consulta');
  });
});
