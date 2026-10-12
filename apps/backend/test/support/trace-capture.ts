import { createRequire } from 'node:module';
import { context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { createInstrumentations } from '@shared/observability/instrumentations';

/**
 * Captura, em memória, o que o backend exportaria como trace — Tarefa 07 da
 * auditoria (Fase 1).
 *
 * As instrumentações são as de produção (`createInstrumentations()`, a mesma
 * função que tracing.ts chama); só o destino muda: em vez de um coletor
 * OTLP, uma lista em memória que o teste lê. Nada sai da máquina.
 *
 * As instrumentações alteram os módulos quando eles passam pelo `require()`.
 * Em produção isso acontece porque tracing.ts é o primeiro import. Aqui os
 * módulos já estão carregados, então cada um é pedido de novo por
 * `require()` depois de as instrumentações serem ligadas — é o que dispara a
 * alteração, feita no próprio objeto do módulo (e nos protótipos), que é o
 * mesmo para quem já o tinha importado.
 */
export interface TraceCapture {
  /** Spans terminados até agora. */
  spans(): ReadableSpan[];
  /** Tudo o que há de texto nos spans terminados: nomes, atributos, eventos, status e recurso. */
  exported(): string;
  /** Esquece os spans capturados até aqui. */
  reset(): void;
  /**
   * Roda `work` dentro de um span capturado. A instrumentação do Redis só
   * grava comandos emitidos dentro de um span — em produção, o da requisição
   * ou o do worker.
   */
  inSpan<T>(name: string, work: () => Promise<T>): Promise<T>;
  stop(): Promise<void>;
}

const INSTRUMENTED_MODULES = ['http', 'https', 'ioredis'];

export function startTraceCapture(): TraceCapture {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();

  const instrumentations = createInstrumentations();
  for (const instrumentation of instrumentations) {
    instrumentation.setTracerProvider(provider);
    instrumentation.enable();
  }

  const requireFromHere = createRequire(__filename);
  for (const name of INSTRUMENTED_MODULES) requireFromHere(name);
  // O Express é dependência do adaptador do Nest, não direta deste pacote.
  createRequire(requireFromHere.resolve('@nestjs/platform-express'))('express');

  const content = (span: ReadableSpan) => ({
    name: span.name,
    attributes: span.attributes,
    events: span.events.map((event) => ({ name: event.name, attributes: event.attributes })),
    links: span.links.map((link) => link.attributes),
    status: span.status,
    resource: span.resource.attributes,
  });

  return {
    spans: () => exporter.getFinishedSpans(),
    exported: () => JSON.stringify(exporter.getFinishedSpans().map(content)),
    reset: () => exporter.reset(),
    inSpan: (name, work) =>
      provider.getTracer('trace-capture').startActiveSpan(name, async (span) => {
        try {
          return await work();
        } finally {
          span.end();
        }
      }),
    stop: async () => {
      for (const instrumentation of instrumentations) instrumentation.disable();
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}
