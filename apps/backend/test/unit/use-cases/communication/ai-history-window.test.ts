import { describe, it, expect } from 'vitest';
import { Message } from '@domain/communication/conversation.entity';
import {
  aiHistoryWindow,
  toAiHistory,
  DEFAULT_AI_HISTORY_MAX_AGE_HOURS,
  DEFAULT_AI_HISTORY_MAX_MESSAGES,
} from '@use-cases/communication/ai-history-window';

const NOW = new Date('2031-03-10T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function message(id: string, direction: 'entrada' | 'saida', content: string) {
  return Message.reconstitute({ id, conversationId: 'c1', tenantId: 't1', direction, content });
}

describe('aiHistoryWindow — D-A do A-14', () => {
  it('padrão aprovado: 20 mensagens contando a atual (19 anteriores) e 72 horas', () => {
    expect(DEFAULT_AI_HISTORY_MAX_MESSAGES).toBe(20);
    expect(DEFAULT_AI_HISTORY_MAX_AGE_HOURS).toBe(72);
    expect(aiHistoryWindow(NOW, {})).toEqual({ previousLimit: 19, since: new Date(NOW.getTime() - 72 * HOUR) });
  });

  it('os dois valores podem ser ajustados pela configuração', () => {
    const window = aiHistoryWindow(NOW, { AI_HISTORY_MAX_MESSAGES: '10', AI_HISTORY_MAX_AGE_HOURS: '24' });
    expect(window).toEqual({ previousLimit: 9, since: new Date(NOW.getTime() - 24 * HOUR) });
  });

  it.each(['0', '-3', '2.5', 'abc', ''])('valor que não é inteiro positivo (%j) nunca abre a janela: vale o padrão', (raw) => {
    expect(aiHistoryWindow(NOW, { AI_HISTORY_MAX_MESSAGES: raw, AI_HISTORY_MAX_AGE_HOURS: raw })).toEqual({
      previousLimit: 19,
      since: new Date(NOW.getTime() - 72 * HOUR),
    });
  });
});

describe('toAiHistory — D-A do A-14', () => {
  it('mantém a ordem e converte entrada em "user" e saída em "assistant"', () => {
    const history = toAiHistory([message('m1', 'entrada', 'Oi'), message('m2', 'saida', 'Olá!'), message('m3', 'entrada', 'Tem horário?')]);
    expect(history).toEqual([
      { role: 'user', content: 'Oi' },
      { role: 'assistant', content: 'Olá!' },
      { role: 'user', content: 'Tem horário?' },
    ]);
  });

  it('o trecho nunca começa por uma resposta do assistente: as respostas que abrem o corte ficam de fora', () => {
    const history = toAiHistory([
      message('m1', 'saida', 'resposta cuja pergunta ficou fora do corte'),
      message('m2', 'saida', 'outra resposta'),
      message('m3', 'entrada', 'Quero remarcar'),
      message('m4', 'saida', 'Para quando?'),
    ]);
    expect(history).toEqual([
      { role: 'user', content: 'Quero remarcar' },
      { role: 'assistant', content: 'Para quando?' },
    ]);
  });

  it('só respostas do assistente, ou nada, viram histórico vazio', () => {
    expect(toAiHistory([message('m1', 'saida', 'Olá!')])).toEqual([]);
    expect(toAiHistory([])).toEqual([]);
  });
});
