import { LoggerService, LogLevel } from '@nestjs/common';
import { JsonLogger, NEST_LOG_LEVELS, NestLogLevel } from './json-logger';

export type LogFormat = 'json' | 'text';

export const LOG_FORMATS: readonly LogFormat[] = ['json', 'text'];

/**
 * Formato dos logs. `LOG_FORMAT` decide quando definida; sem ela, JSON em
 * produção (uma linha por registro, para o coletor) e o texto colorido do
 * Nest fora dela (para quem lê o terminal).
 */
export function resolveLogFormat(env: NodeJS.ProcessEnv = process.env): LogFormat {
  const explicit = env.LOG_FORMAT?.trim().toLowerCase();
  if (explicit === 'json' || explicit === 'text') return explicit;
  return env.NODE_ENV === 'production' ? 'json' : 'text';
}

/**
 * Nível mínimo. `LOG_LEVEL` decide quando definida; sem ela, "log" (INFO) em
 * JSON e "verbose" em texto — o que o Nest já mostrava em desenvolvimento.
 */
export function resolveMinLogLevel(env: NodeJS.ProcessEnv = process.env): NestLogLevel {
  const explicit = env.LOG_LEVEL?.trim().toLowerCase() as NestLogLevel | undefined;
  if (explicit && NEST_LOG_LEVELS.includes(explicit)) return explicit;
  return resolveLogFormat(env) === 'json' ? 'log' : 'verbose';
}

/**
 * Valor da opção `logger` de NestFactory.create(): o JsonLogger, ou a lista
 * de níveis habilitados para o logger de texto padrão do Nest.
 */
export function createAppLogger(env: NodeJS.ProcessEnv = process.env): LoggerService | LogLevel[] {
  const minLevel = resolveMinLogLevel(env);
  if (resolveLogFormat(env) === 'json') {
    return new JsonLogger({
      service: 'luxora-backend',
      version: env.APP_VERSION ?? 'dev',
      environment: env.APP_ENV ?? env.NODE_ENV ?? 'development',
      minLevel,
    });
  }
  return NEST_LOG_LEVELS.slice(0, NEST_LOG_LEVELS.indexOf(minLevel) + 1) as LogLevel[];
}
