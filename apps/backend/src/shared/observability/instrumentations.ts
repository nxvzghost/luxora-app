import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { isProbeRequest } from './telemetry-env';
import { redactUrlAttributes, serializeRedisCommand } from './trace-redaction';

/**
 * As instrumentações do backend, em um lugar só — é daqui que tracing.ts as
 * tira, e é daqui que os testes as tiram para conferir o que elas exportam
 * (test/support/trace-capture.ts). O que vale em produção é o que é testado.
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
 * Tarefa 07 da auditoria — nada sensível sai nos spans (ver trace-redaction.ts):
 *   - HTTP: `requestHook` roda logo depois de o span ser criado, na
 *     requisição que chega e na que sai, e regrava os atributos de endereço
 *     sem os valores da query string. Cabeçalhos e corpo nunca foram
 *     capturados, e continuam não sendo (`headersToSpanAttributes` não é
 *     configurado).
 *   - Redis: `dbStatementSerializer` troca o texto do comando por nome e
 *     quantidade de argumentos.
 * As sondas de saúde e a coleta de métricas não geram trace.
 */
export function createInstrumentations() {
  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (request) => isProbeRequest(request.url),
      requestHook: (span) => redactUrlAttributes(span),
    }),
    new ExpressInstrumentation(),
    new IORedisInstrumentation({ dbStatementSerializer: serializeRedisCommand }),
  ];
}
