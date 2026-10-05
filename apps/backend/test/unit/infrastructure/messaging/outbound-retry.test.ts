import { describe, it, expect } from 'vitest';
import {
  MAX_PROVIDER_RETRY_AFTER_MS,
  OUTBOUND_BASE_BACKOFF_MS,
  outboundRetryDelayMs,
  parseRetryAfterMs,
} from '@infrastructure/messaging/outbound-retry';
import { MessageProviderError } from '@domain-services/communication/message-provider';

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

function rateLimited(retryAfterMs?: number): MessageProviderError {
  return new MessageProviderError('limite de requisições', true, 429, retryAfterMs);
}

describe('parseRetryAfterMs — leitura do cabeçalho Retry-After (Fase 3B)', () => {
  it.each([
    ['5', 5000],
    [' 30 ', 30000],
    ['0', 0],
    ['86400', 86_400_000],
  ])('segundos inteiros: %j → %i ms', (header, expected) => {
    expect(parseRetryAfterMs(header, NOW)).toBe(expected);
  });

  it('data HTTP no futuro: diferença até agora', () => {
    expect(parseRetryAfterMs('Mon, 05 Oct 2026 12:00:30 GMT', NOW)).toBe(30000);
  });

  it('data HTTP no passado: 0', () => {
    expect(parseRetryAfterMs('Mon, 05 Oct 2026 11:59:00 GMT', NOW)).toBe(0);
  });

  it.each([
    ['ausente (null)', null],
    ['ausente (undefined)', undefined],
    ['vazio', ''],
    ['só espaços', '   '],
    ['texto', 'daqui a pouco'],
    ['negativo', '-5'],
    ['decimal', '1.5'],
    ['número com unidade', '10s'],
    ['número gigantesco', '9'.repeat(400)],
  ])('inválido — %s: undefined', (_label, header) => {
    expect(parseRetryAfterMs(header, NOW)).toBeUndefined();
  });
});

describe('outboundRetryDelayMs — espera antes da próxima tentativa (Fase 3B)', () => {
  it('sem indicação do provider: 2 s e 4 s, igual ao exponencial de antes', () => {
    expect(OUTBOUND_BASE_BACKOFF_MS).toBe(2000);
    expect(outboundRetryDelayMs(1)).toBe(2000);
    expect(outboundRetryDelayMs(2)).toBe(4000);
    expect(outboundRetryDelayMs(1, new Error('falha de rede'))).toBe(2000);
    expect(outboundRetryDelayMs(2, rateLimited())).toBe(4000);
  });

  it('Retry-After válido e maior que a espera padrão: respeitado', () => {
    expect(outboundRetryDelayMs(1, rateLimited(5000))).toBe(5000);
    expect(outboundRetryDelayMs(2, rateLimited(30000))).toBe(30000);
  });

  it('Retry-After menor que a espera padrão: vale a espera padrão (o provider não acelera o worker)', () => {
    expect(outboundRetryDelayMs(1, rateLimited(0))).toBe(2000);
    expect(outboundRetryDelayMs(1, rateLimited(500))).toBe(2000);
    expect(outboundRetryDelayMs(2, rateLimited(3000))).toBe(4000);
  });

  it('Retry-After absurdo: limitado ao teto', () => {
    expect(MAX_PROVIDER_RETRY_AFTER_MS).toBe(60000);
    expect(outboundRetryDelayMs(1, rateLimited(86_400_000))).toBe(60000);
    expect(outboundRetryDelayMs(1, rateLimited(Number.MAX_SAFE_INTEGER))).toBe(60000);
  });

  it('valor não finito no erro: ignorado, vale a espera padrão', () => {
    expect(outboundRetryDelayMs(1, rateLimited(Number.NaN))).toBe(2000);
    expect(outboundRetryDelayMs(1, rateLimited(Number.POSITIVE_INFINITY))).toBe(2000);
  });

  it('cabeçalho lido e aplicado de ponta a ponta', () => {
    const delayFor = (header: string | null) => outboundRetryDelayMs(1, rateLimited(parseRetryAfterMs(header, NOW)));

    expect(delayFor('7')).toBe(7000);
    expect(delayFor(null)).toBe(2000);
    expect(delayFor('lixo')).toBe(2000);
    expect(delayFor('999999')).toBe(60000);
  });
});
