/**
 * Configuração da telemetria a partir do ambiente — Tarefa 04 da auditoria.
 *
 * Função pura, sem import nenhum, de propósito: é chamada por tracing.ts
 * antes de qualquer outro módulo ser carregado (ver o comentário lá).
 *
 * Devolve só as variáveis padrão do OpenTelemetry que o operador NÃO definiu;
 * o que ele definiu vale como veio. O NodeSDK lê essas variáveis sozinho.
 *
 * Para onde vão os traces:
 *   - OTEL_TRACES_EXPORTER definida        → respeitada (otlp, console, none);
 *   - um endpoint OTLP configurado          → "otlp";
 *   - produção sem endpoint                 → "none" (nada é exportado nem
 *                                             impresso: o stdout fica só com
 *                                             os logs em JSON);
 *   - fora de produção sem endpoint         → "console", como era antes.
 *
 * O protocolo e o endereço seguem as variáveis padrão:
 * OTEL_EXPORTER_OTLP_ENDPOINT (ou …_TRACES_ENDPOINT) e
 * OTEL_EXPORTER_OTLP_PROTOCOL (padrão http/protobuf). Nenhum backend pago é
 * necessário: qualquer coletor OTLP serve (ver infra/staging).
 */
export function resolveTelemetryEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const defaults: Record<string, string> = {};
  const isSet = (name: string): boolean => Boolean(env[name]?.trim());

  if (!isSet('OTEL_TRACES_EXPORTER')) {
    const hasEndpoint = isSet('OTEL_EXPORTER_OTLP_ENDPOINT') || isSet('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT');
    defaults.OTEL_TRACES_EXPORTER = hasEndpoint ? 'otlp' : env.NODE_ENV === 'production' ? 'none' : 'console';
  }

  // A aplicação não usa a API de logs do OpenTelemetry (os logs saem em JSON
  // pelo stdout). Sem isto o SDK ainda montaria um exportador OTLP de logs.
  if (!isSet('OTEL_LOGS_EXPORTER')) defaults.OTEL_LOGS_EXPORTER = 'none';

  // Versão e ambiente em todo span, para separar staging de produção e uma
  // versão da outra no backend de traces.
  if (!isSet('OTEL_RESOURCE_ATTRIBUTES')) {
    const attributes = [
      `service.version=${env.APP_VERSION?.trim() || 'dev'}`,
      `deployment.environment.name=${env.APP_ENV?.trim() || env.NODE_ENV?.trim() || 'development'}`,
    ];
    defaults.OTEL_RESOURCE_ATTRIBUTES = attributes.join(',');
  }

  return defaults;
}

/** Rotas de sonda e de coleta: chamadas a cada poucos segundos, não merecem um trace cada. */
export function isProbeRequest(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split('?')[0];
  return path === '/metrics' || path === '/api/v1/health' || path.startsWith('/api/v1/health/');
}
