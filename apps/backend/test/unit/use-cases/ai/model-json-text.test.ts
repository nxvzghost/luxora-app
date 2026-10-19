import { describe, it, expect } from 'vitest';
import { unwrapModelJson } from '@use-cases/ai/model-json-text';
import { REAL_INTENT_RESPONSE } from './support/real-anthropic-responses';

const FENCE = '```';

describe('unwrapModelJson — JSON do modelo real entre cercas de código (19/10/2026)', () => {
  it('a resposta real de interpretIntent vira um JSON legível', () => {
    expect(JSON.parse(unwrapModelJson(REAL_INTENT_RESPONSE))).toEqual({
      intent: 'consultar_disponibilidade',
      confidence: 0.95,
      entities: { dia_semana: 'quinta-feira', periodo: 'tarde' },
      requiresEscalation: false,
    });
  });

  it('JSON puro passa sem mudança', () => {
    expect(unwrapModelJson('{"intent":"outro"}')).toBe('{"intent":"outro"}');
  });

  it('cerca sem o nome da linguagem', () => {
    expect(unwrapModelJson(`${FENCE}\n{"a":1}\n${FENCE}`)).toBe('{"a":1}');
  });

  it('nome da linguagem em maiúsculas e espaços em volta', () => {
    expect(unwrapModelJson(`  \n${FENCE}JSON\n{"a":1}\n${FENCE}\n `)).toBe('{"a":1}');
  });

  it('cerca e conteúdo na mesma linha', () => {
    expect(unwrapModelJson(`${FENCE}json {"a":1} ${FENCE}`)).toBe('{"a":1}');
  });

  it('texto antes da cerca: não procura JSON no meio do texto', () => {
    const text = `Aqui está:\n${FENCE}json\n{"a":1}\n${FENCE}`;
    expect(unwrapModelJson(text)).toBe(text);
  });

  it('texto depois da cerca: idem', () => {
    const text = `${FENCE}json\n{"a":1}\n${FENCE}\nEspero ter ajudado.`;
    expect(unwrapModelJson(text)).toBe(text);
  });

  it('cerca de outra linguagem não vira JSON legível', () => {
    expect(() => JSON.parse(unwrapModelJson(`${FENCE}jsonc\n{"a":1}\n${FENCE}`))).toThrow();
  });

  it('cerca vazia vira texto vazio', () => {
    expect(unwrapModelJson(`${FENCE}json\n${FENCE}`)).toBe('');
  });
});
