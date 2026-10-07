import { describe, it, expect } from 'vitest';
import { createAppLogger, resolveLogFormat, resolveMinLogLevel } from '@shared/logging/app-logger';
import { JsonLogger } from '@shared/logging/json-logger';

/**
 * Tarefa 04 da auditoria — escolha do formato e do nível de log pelo ambiente.
 */
describe('formato e nível dos logs', () => {
  it('produção sem LOG_FORMAT: JSON', () => {
    expect(resolveLogFormat({ NODE_ENV: 'production' })).toBe('json');
  });

  it.each(['development', 'test', undefined])('NODE_ENV=%s sem LOG_FORMAT: texto, como o Nest já fazia', (nodeEnv) => {
    expect(resolveLogFormat({ NODE_ENV: nodeEnv })).toBe('text');
  });

  it('LOG_FORMAT decide quando definida, em qualquer ambiente', () => {
    expect(resolveLogFormat({ NODE_ENV: 'production', LOG_FORMAT: 'text' })).toBe('text');
    expect(resolveLogFormat({ NODE_ENV: 'development', LOG_FORMAT: ' JSON ' })).toBe('json');
  });

  it('nível padrão: INFO em JSON, tudo em texto', () => {
    expect(resolveMinLogLevel({ NODE_ENV: 'production' })).toBe('log');
    expect(resolveMinLogLevel({ NODE_ENV: 'development' })).toBe('verbose');
  });

  it('LOG_LEVEL decide quando definida; valor desconhecido cai no padrão', () => {
    expect(resolveMinLogLevel({ NODE_ENV: 'production', LOG_LEVEL: 'debug' })).toBe('debug');
    expect(resolveMinLogLevel({ NODE_ENV: 'production', LOG_LEVEL: 'barulhento' })).toBe('log');
  });

  it('createAppLogger devolve o JsonLogger em produção', () => {
    expect(createAppLogger({ NODE_ENV: 'production' })).toBeInstanceOf(JsonLogger);
  });

  it('createAppLogger devolve a lista de níveis do Nest em texto, respeitando LOG_LEVEL', () => {
    expect(createAppLogger({ NODE_ENV: 'development' })).toEqual(['fatal', 'error', 'warn', 'log', 'debug', 'verbose']);
    expect(createAppLogger({ NODE_ENV: 'development', LOG_LEVEL: 'warn' })).toEqual(['fatal', 'error', 'warn']);
  });
});
