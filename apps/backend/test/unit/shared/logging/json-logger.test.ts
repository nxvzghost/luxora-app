import { describe, it, expect, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { trace, type Span } from '@opentelemetry/api';
import { JsonLogger, NestLogLevel } from '@shared/logging/json-logger';

/**
 * Tarefa 04 da auditoria — logs estruturados. Os testes passam pelo
 * `Logger` do Nest, como o código da aplicação faz, para provar a convenção
 * de contexto e de stack que ele usa ao chamar o logger configurado.
 */

function setup(minLevel: NestLogLevel = 'log') {
  const lines: Array<{ line: string; level: NestLogLevel }> = [];
  const logger = new JsonLogger({
    service: 'luxora-backend',
    version: '94a955a',
    environment: 'staging',
    minLevel,
    write: (line, level) => lines.push({ line, level }),
    now: () => new Date('2026-10-07T12:00:00.000Z'),
  });
  Logger.overrideLogger(logger);
  return { lines, record: (index = 0) => JSON.parse(lines[index].line) as Record<string, unknown> };
}

afterEach(() => {
  Logger.overrideLogger(false);
  vi.restoreAllMocks();
});

describe('JsonLogger', () => {
  it('uma linha JSON por registro, com os campos fixos e o contexto de quem registrou', () => {
    const { lines, record } = setup();

    new Logger('EnviarMensagemUseCase').log('Mensagem enfileirada.');

    expect(lines).toHaveLength(1);
    expect(lines[0].line).not.toContain('\n');
    expect(record()).toEqual({
      timestamp: '2026-10-07T12:00:00.000Z',
      level: 'INFO',
      service: 'luxora-backend',
      version: '94a955a',
      environment: 'staging',
      context: 'EnviarMensagemUseCase',
      message: 'Mensagem enfileirada.',
    });
  });

  it.each<[NestLogLevel, string]>([
    ['fatal', 'CRITICAL'],
    ['error', 'ERROR'],
    ['warn', 'WARNING'],
    ['log', 'INFO'],
    ['debug', 'DEBUG'],
    ['verbose', 'DEBUG'],
  ])('nível %s do Nest sai como %s (nomes do documento de Monitoramento)', (level, severity) => {
    const { record } = setup('verbose');

    (new Logger('Contexto') as unknown as Record<NestLogLevel, (message: string) => void>)[level]('mensagem');

    expect(record().level).toBe(severity);
  });

  it('descarta o que é mais detalhado que o nível mínimo', () => {
    const { lines } = setup('warn');
    const logger = new Logger('Contexto');

    logger.debug('detalhe');
    logger.log('informação');
    logger.warn('aviso');
    logger.error('erro');

    expect(lines.map(({ line }) => JSON.parse(line).level)).toEqual(['WARNING', 'ERROR']);
  });

  it('erro com stack: o stack vai no próprio campo, e a mensagem continua em uma linha', () => {
    const { lines, record } = setup();
    const error = new Error('falhou');

    new Logger('Worker').error(`Job falhou: ${error.message}`, error.stack);

    expect(record().message).toBe('Job falhou: falhou');
    expect(record().stack).toContain('Error: falhou');
    expect(record().context).toBe('Worker');
    expect(record().extra).toBeUndefined();
    expect(lines[0].line).not.toContain('\n');
    expect(lines[0].level).toBe('error');
  });

  it('erro sem stack não confunde o contexto com o stack', () => {
    const { record } = setup();

    new Logger('Worker').error('Job falhou.');

    expect(record().context).toBe('Worker');
    expect(record().stack).toBeUndefined();
  });

  it('um Error passado como mensagem vira texto e stack', () => {
    const { record } = setup();

    new Logger('Filtro').error(new TypeError('valor inválido'));

    expect(record().message).toBe('TypeError: valor inválido');
    expect(record().stack).toContain('TypeError: valor inválido');
  });

  it('extrai o correlationId que a mensagem já carrega (AD-016) para um campo próprio', () => {
    const { record } = setup();

    new Logger('AnthropicAIProvider').warn('[correlationId=abc-123] Tentativa 1/2 falhou.');

    expect(record().correlationId).toBe('abc-123');
    expect(record().message).toBe('[correlationId=abc-123] Tentativa 1/2 falhou.');
  });

  it('inclui traceId e spanId do span ativo, ligando o log ao trace da requisição', () => {
    const { record } = setup();
    const spanContext = { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', traceFlags: 1 };
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue({ spanContext: () => spanContext } as unknown as Span);

    new Logger('Controller').log('dentro da requisição');

    expect(record().traceId).toBe(spanContext.traceId);
    expect(record().spanId).toBe(spanContext.spanId);
  });

  it('objeto como mensagem vira texto de uma linha; referência circular não derruba o log', () => {
    const { lines, record } = setup();
    const circular: Record<string, unknown> = { nome: 'job' };
    circular.self = circular;

    new Logger('Contexto').log(circular);

    expect(lines).toHaveLength(1);
    expect(record().message).toContain("nome: 'job'");
  });

  it('parâmetros extras (além de contexto e stack) ficam em "extra"', () => {
    const { record } = setup();

    new Logger('Contexto').log('mensagem', { tentativas: 2 }, 'observação');

    expect(record().context).toBe('Contexto');
    expect(record().extra).toEqual(['{ tentativas: 2 }', 'observação']);
  });

  it('sem `write` injetado, ERROR e CRITICAL vão para stderr e o resto para stdout', () => {
    const out: string[] = [];
    const err: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => (out.push(chunk), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => (err.push(chunk), true)) as typeof process.stderr.write;
    try {
      const logger = new JsonLogger({ service: 's', version: 'v', environment: 'e', minLevel: 'log' });
      logger.log('informação', 'Contexto');
      logger.error('erro', 'Contexto');
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }

    expect(out).toHaveLength(1);
    expect(err).toHaveLength(1);
    expect(JSON.parse(out[0]).level).toBe('INFO');
    expect(JSON.parse(err[0]).level).toBe('ERROR');
    expect(out[0].endsWith('\n')).toBe(true);
  });
});
