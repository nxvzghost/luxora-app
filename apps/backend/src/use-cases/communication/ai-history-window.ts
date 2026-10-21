import { ConversationMessage } from '@domain-services/ai/ai-provider';
import { Message } from '@domain/communication/conversation.entity';

/**
 * D-A do A-14 (decisão de 20/10/2026, docs/12-Privacidade-e-Dados/06):
 * cada chamada à IA leva só o trecho recente da conversa — no máximo 20
 * mensagens, contando a atual, e só as das últimas 72 horas. O histórico
 * gravado no banco não muda: o corte vale só para o que sai para o provedor.
 * A regra é a mesma para todas as clínicas; os dois valores podem ser
 * ajustados por AI_HISTORY_MAX_MESSAGES e AI_HISTORY_MAX_AGE_HOURS (inteiros
 * positivos, conferidos no boot por src/shared/env.validation.ts).
 */
export const DEFAULT_AI_HISTORY_MAX_MESSAGES = 20;
export const DEFAULT_AI_HISTORY_MAX_AGE_HOURS = 72;

const HOUR_IN_MS = 60 * 60 * 1000;

export interface AiHistoryWindow {
  /** Quantas mensagens anteriores à atual podem ir — a atual ocupa a última vaga. */
  previousLimit: number;
  /** Mensagens criadas antes deste instante ficam de fora. */
  since: Date;
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function aiHistoryWindow(now: Date, env: NodeJS.ProcessEnv = process.env): AiHistoryWindow {
  const maxMessages = positiveInteger(env.AI_HISTORY_MAX_MESSAGES, DEFAULT_AI_HISTORY_MAX_MESSAGES);
  const maxAgeHours = positiveInteger(env.AI_HISTORY_MAX_AGE_HOURS, DEFAULT_AI_HISTORY_MAX_AGE_HOURS);
  return { previousLimit: maxMessages - 1, since: new Date(now.getTime() - maxAgeHours * HOUR_IN_MS) };
}

/**
 * Converte as mensagens anteriores, já cortadas e em ordem cronológica, no
 * histórico da IA. A lista enviada à Anthropic não pode começar por uma
 * mensagem do assistente (a API responde 400), e o corte por quantidade ou
 * por tempo pode cair logo depois de uma mensagem do paciente, deixando uma
 * resposta no início: as respostas que abrem o trecho ficam de fora.
 */
export function toAiHistory(previous: Message[]): ConversationMessage[] {
  const firstFromPatient = previous.findIndex((message) => message.direction === 'entrada');
  if (firstFromPatient === -1) return [];
  return previous.slice(firstFromPatient).map((message) => ({
    role: message.direction === 'entrada' ? 'user' : 'assistant',
    content: message.content,
  }));
}
