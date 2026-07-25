import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';

/**
 * tracing.ts — AD-016.
 *
 * PRECISA ser o primeiro import de main.ts, antes até de 'reflect-metadata'.
 * As instrumentações do OTel funcionam via monkey-patch dos módulos no
 * `require()` — se `http`/`express`/`ioredis` já tiverem sido carregados
 * antes deste arquivo rodar, a instrumentação correspondente não tem efeito
 * nenhum. Por isso é um arquivo próprio, nunca um trecho dentro de main.ts.
 *
 * Deliberadamente SEM @opentelemetry/auto-instrumentations-node — decisão
 * explícita do usuário na aprovação da auditoria da AD-016: instrumentações
 * registradas uma a uma, para nunca instrumentar módulos irrelevantes (ex:
 * fs, dns, net) por padrão, reduzindo overhead e ruído. Cobre exatamente
 * HTTP, Express e ioredis — BullMQ usa ioredis por baixo (ver
 * infrastructure/messaging/*.ts), então esta instrumentação também cobre a
 * fila; não existe (nem é necessário) um pacote de instrumentação BullMQ
 * dedicado para isso.
 *
 * Instrumentação de queries do Prisma foi deliberadamente ADIADA nesta AD —
 * ver ADR-0051, seção "Limitações conhecidas": exigiria
 * `previewFeatures = ["tracing"]` no schema.prisma, recurso experimental do
 * Prisma 5.22.0 (versão instalada, confirmado lendo o runtime do client) —
 * rejeitado explicitamente para não acoplar a arquitetura a uma dependência
 * experimental do Prisma.
 *
 * Exportação de traces: ConsoleSpanExporter por enquanto — não existe hoje
 * nenhum backend de tracing provisionado (docker-compose.yml só tem
 * Postgres/Redis; ver auditoria, seção 4). Trocar por um exportador OTLP
 * real é uma troca de uma linha aqui quando um backend for escolhido, sem
 * tocar nenhum outro arquivo desta AD.
 *
 * Exportação de métricas: Prometheus, real — ver api/metrics/metrics.controller.ts,
 * que expõe `prometheusExporter.getMetricsRequestHandler` atrás de um guard.
 */
export const prometheusExporter = new PrometheusExporter({ preventServerStart: true });

const sdk = new NodeSDK({
  serviceName: 'luxora-backend',
  spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
  metricReaders: [prometheusExporter],
  instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation(), new IORedisInstrumentation()],
});

sdk.start();

async function shutdown(): Promise<void> {
  try {
    await sdk.shutdown();
  } catch {
    // encerramento do processo não deve travar por causa de telemetria.
  }
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
