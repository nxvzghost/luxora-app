import { NodeSDK } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { isProbeRequest, resolveTelemetryEnv } from './shared/observability/telemetry-env';

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
 * Exportação de traces (Tarefa 04 da auditoria): decidida pelo ambiente, com
 * as variáveis padrão do OpenTelemetry — ver shared/observability/telemetry-env.ts.
 * Com um endpoint OTLP configurado (OTEL_EXPORTER_OTLP_ENDPOINT), os spans
 * vão para ele; em produção sem endpoint, nada é exportado; fora de produção
 * sem endpoint, continuam saindo no console, como antes. O SDK monta o
 * exportador sozinho a partir dessas variáveis — por isso nenhum
 * `spanProcessors` é passado abaixo. As sondas de saúde e a coleta de
 * métricas não geram trace.
 *
 * Exportação de métricas: Prometheus, real — ver api/metrics/metrics.controller.ts,
 * que expõe `prometheusExporter.getMetricsRequestHandler` atrás de um guard.
 */
export const prometheusExporter = new PrometheusExporter({ preventServerStart: true });

// Só preenche o que o operador não definiu; precisa rodar antes do NodeSDK,
// que lê estas variáveis ao ser construído.
Object.assign(process.env, resolveTelemetryEnv(process.env));

const sdk = new NodeSDK({
  serviceName: 'luxora-backend',
  metricReaders: [prometheusExporter],
  instrumentations: [
    new HttpInstrumentation({ ignoreIncomingRequestHook: (request) => isProbeRequest(request.url) }),
    new ExpressInstrumentation(),
    new IORedisInstrumentation(),
  ],
});

sdk.start();

async function shutdown(): Promise<void> {
  try {
    await sdk.shutdown();
  } catch {
    // encerramento do processo não deve travar por causa de telemetria.
  }
}

// Fase 3B da auditoria — `once`, não `on`. Um listener permanente de SIGTERM
// tira do Node o comportamento padrão de terminar: o processo recebia o
// sinal, encerrava só a telemetria e continuava de pé. Com `once`, este
// listener sai no primeiro sinal; quando o Nest termina o encerramento
// gracioso e reenvia o sinal (enableShutdownHooks, em main.ts), não sobra
// listener nenhum e o processo termina.
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
