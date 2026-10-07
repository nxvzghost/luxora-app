import { LoggerService } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { inspect } from 'node:util';

/** Níveis do Nest, do mais grave para o mais detalhado. */
export const NEST_LOG_LEVELS = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] as const;
export type NestLogLevel = (typeof NEST_LOG_LEVELS)[number];

/** Nomes de nível definidos em docs/02-Arquitetura/11-Monitoramento.md ("Níveis de Log"). */
const SEVERITY: Record<NestLogLevel, string> = {
  fatal: 'CRITICAL',
  error: 'ERROR',
  warn: 'WARNING',
  log: 'INFO',
  debug: 'DEBUG',
  verbose: 'DEBUG',
};

export interface JsonLoggerOptions {
  service: string;
  version: string;
  environment: string;
  /** Nível mínimo registrado; os mais detalhados que ele são descartados. */
  minLevel: NestLogLevel;
  /** Só para teste: destino das linhas. Padrão: stdout, e stderr para ERROR/CRITICAL. */
  write?: (line: string, level: NestLogLevel) => void;
  /** Só para teste: relógio. */
  now?: () => Date;
}

const CORRELATION_ID_IN_MESSAGE = /\[correlationId=([^\]\s]+)\]/;
const LOOKS_LIKE_STACK = /\n\s+at .+:\d+:\d+/;

/**
 * JsonLogger — logs estruturados (Tarefa 04 da auditoria).
 *
 * Uma linha JSON por registro, em stdout/stderr, que é o que qualquer
 * coletor de logs (Loki, o painel do provedor, `docker logs`) lê sem
 * configuração. Substitui o ConsoleLogger do Nest por inteiro: todo
 * `new Logger(Contexto)` do código passa por aqui, sem mudar nenhuma chamada.
 *
 * Campos (docs/02-Arquitetura/11-Monitoramento.md, "Logs"): timestamp, level,
 * service, version, environment, context (a classe que registrou — o Caso de
 * Uso, quando é um), message e, quando existem:
 *   - correlationId: extraído do marcador `[correlationId=…]` que o código já
 *     escreve nas mensagens (AD-016);
 *   - traceId / spanId: do span ativo do OpenTelemetry, o que liga cada linha
 *     de log ao trace da mesma requisição;
 *   - stack: de erros.
 *
 * TenantID e UserID do documento NÃO saem automaticamente: os dois vivem em
 * objetos de escopo de requisição, que um logger global não enxerga. Só
 * aparecem quando a mensagem os inclui.
 *
 * O logger não inspeciona nem mascara o conteúdo: continua valendo a regra
 * de nunca registrar token, chave ou corpo de mensagem.
 */
export class JsonLogger implements LoggerService {
  private readonly minIndex: number;

  constructor(private readonly options: JsonLoggerOptions) {
    this.minIndex = NEST_LOG_LEVELS.indexOf(options.minLevel);
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('log', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('fatal', message, optionalParams);
  }

  private emit(level: NestLogLevel, message: unknown, optionalParams: unknown[]): void {
    if (NEST_LOG_LEVELS.indexOf(level) > this.minIndex) return;

    // O Logger do Nest preenche com `undefined` a posição do stack quando só
    // tem o contexto para passar.
    const params = optionalParams.filter((param) => param !== undefined);
    // Convenção do Nest: o último parâmetro, quando é texto, é o contexto; em
    // error(), um texto com cara de stack trace antes dele é o stack.
    let context: string | undefined;
    let stack: string | undefined;
    const last = params[params.length - 1];
    if (typeof last === 'string' && !LOOKS_LIKE_STACK.test(last)) {
      context = params.pop() as string;
    }
    if ((level === 'error' || level === 'fatal') && typeof params[0] === 'string' && LOOKS_LIKE_STACK.test(params[0])) {
      stack = params.shift() as string;
    }

    let text: string;
    if (message instanceof Error) {
      text = `${message.name}: ${message.message}`;
      stack ??= message.stack;
    } else {
      text = typeof message === 'string' ? message : safeInspect(message);
    }

    const span = trace.getActiveSpan()?.spanContext();
    const record: Record<string, unknown> = {
      timestamp: (this.options.now?.() ?? new Date()).toISOString(),
      level: SEVERITY[level],
      service: this.options.service,
      version: this.options.version,
      environment: this.options.environment,
      context,
      message: text,
      correlationId: CORRELATION_ID_IN_MESSAGE.exec(text)?.[1],
      traceId: span?.traceId,
      spanId: span?.spanId,
      stack,
      extra: params.length > 0 ? params.map((param) => (typeof param === 'string' ? param : safeInspect(param))) : undefined,
    };

    const line = JSON.stringify(record);
    if (this.options.write) {
      this.options.write(line, level);
    } else {
      (level === 'error' || level === 'fatal' ? process.stderr : process.stdout).write(`${line}\n`);
    }
  }
}

/** Objetos viram texto de uma linha; referência circular ou getter que lança não derruba o log. */
function safeInspect(value: unknown): string {
  try {
    return inspect(value, { depth: 4, breakLength: Infinity, compact: true });
  } catch {
    return '[valor não serializável]';
  }
}
