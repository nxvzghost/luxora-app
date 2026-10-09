import { describe, it, expect } from 'vitest';
import { parseContactIntentResponse } from '@use-cases/ai/contact-intent-response-parser';

describe('parseContactIntentResponse — ADR-0055 (AD-018), Fase 7', () => {
  it('interpreta um JSON válido com todos os campos', () => {
    const result = parseContactIntentResponse(
      JSON.stringify({ decision: 'PROMOVER', confidence: 0.9, patientNameHint: 'Maria', reasoning: 'primeira consulta' }),
    );
    expect(result).toEqual({ decision: 'PROMOVER', confidence: 0.9, patientNameHint: 'Maria', explicitConfirmation: false, reasoning: 'primeira consulta' });
  });

  it('interpreta um JSON válido só com os campos obrigatórios', () => {
    const result = parseContactIntentResponse(JSON.stringify({ decision: 'IGNORAR', confidence: 0.5 }));
    expect(result.decision).toBe('IGNORAR');
    expect(result.patientNameHint).toBeUndefined();
  });

  it('cai para HUMANO quando o texto não é um JSON válido', () => {
    const result = parseContactIntentResponse('isto não é JSON');
    expect(result).toEqual({ decision: 'HUMANO', confidence: 0, reasoning: 'Falha ao interpretar resposta do modelo.' });
  });

  it('cai para HUMANO quando "decision" está fora do vocabulário esperado — nunca inventa um rótulo', () => {
    const result = parseContactIntentResponse(JSON.stringify({ decision: 'TALVEZ', confidence: 0.5 }));
    expect(result.decision).toBe('HUMANO');
  });

  it('cai para HUMANO em uma string vazia', () => {
    const result = parseContactIntentResponse('');
    expect(result.decision).toBe('HUMANO');
  });

  describe('explicitConfirmation — ADR-0063 (AD-037)', () => {
    it('só o booleano true é confirmação', () => {
      const result = parseContactIntentResponse(JSON.stringify({ decision: 'PROMOVER', confidence: 0.9, explicitConfirmation: true }));
      expect(result.explicitConfirmation).toBe(true);
    });

    it.each(['true', 'sim', 1, null, {}, []])('%j não é confirmação', (value) => {
      const result = parseContactIntentResponse(JSON.stringify({ decision: 'PROMOVER', confidence: 0.9, explicitConfirmation: value }));
      expect(result.explicitConfirmation).toBe(false);
    });

    it('ausente, não há confirmação', () => {
      const result = parseContactIntentResponse(JSON.stringify({ decision: 'PROMOVER', confidence: 0.9 }));
      expect(result.explicitConfirmation).toBe(false);
    });

    it('resposta ilegível nunca vira confirmação', () => {
      expect(parseContactIntentResponse('{"explicitConfirmation": true').explicitConfirmation).toBeUndefined();
    });

    it('patientNameHint que não é texto é descartado', () => {
      const result = parseContactIntentResponse(JSON.stringify({ decision: 'PROMOVER', confidence: 0.9, patientNameHint: { nome: 'x' } }));
      expect(result.patientNameHint).toBeUndefined();
    });
  });
});
