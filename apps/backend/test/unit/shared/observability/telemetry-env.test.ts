import { describe, it, expect } from 'vitest';
import { isProbeRequest, resolveTelemetryEnv } from '@shared/observability/telemetry-env';

/**
 * Tarefa 04 da auditoria — para onde vão os traces, decidido pelo ambiente.
 */
describe('resolveTelemetryEnv', () => {
  it('produção sem endpoint: nada é exportado nem impresso', () => {
    expect(resolveTelemetryEnv({ NODE_ENV: 'production' }).OTEL_TRACES_EXPORTER).toBe('none');
  });

  it.each(['development', 'test', undefined])('NODE_ENV=%s sem endpoint: console, como era antes', (nodeEnv) => {
    expect(resolveTelemetryEnv({ NODE_ENV: nodeEnv }).OTEL_TRACES_EXPORTER).toBe('console');
  });

  it.each(['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'])(
    'com %s configurado, exporta por OTLP em qualquer ambiente',
    (name) => {
      const endpoint = { [name]: 'http://otel-collector:4318' };
      expect(resolveTelemetryEnv({ NODE_ENV: 'production', ...endpoint }).OTEL_TRACES_EXPORTER).toBe('otlp');
      expect(resolveTelemetryEnv({ NODE_ENV: 'development', ...endpoint }).OTEL_TRACES_EXPORTER).toBe('otlp');
    },
  );

  it('endpoint vazio não conta como configurado', () => {
    expect(resolveTelemetryEnv({ NODE_ENV: 'production', OTEL_EXPORTER_OTLP_ENDPOINT: '  ' }).OTEL_TRACES_EXPORTER).toBe('none');
  });

  it('o que o operador definiu não é sobrescrito', () => {
    const defaults = resolveTelemetryEnv({
      NODE_ENV: 'production',
      OTEL_TRACES_EXPORTER: 'console',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_RESOURCE_ATTRIBUTES: 'service.version=1.2.3',
    });
    expect(defaults).toEqual({});
  });

  it('desliga o exportador de logs do SDK, que a aplicação não usa', () => {
    expect(resolveTelemetryEnv({ NODE_ENV: 'production' }).OTEL_LOGS_EXPORTER).toBe('none');
  });

  it('marca todo span com a versão e o ambiente', () => {
    expect(resolveTelemetryEnv({ NODE_ENV: 'production', APP_VERSION: '94a955a', APP_ENV: 'staging' }).OTEL_RESOURCE_ATTRIBUTES).toBe(
      'service.version=94a955a,deployment.environment.name=staging',
    );
    expect(resolveTelemetryEnv({ NODE_ENV: 'production' }).OTEL_RESOURCE_ATTRIBUTES).toBe(
      'service.version=dev,deployment.environment.name=production',
    );
    expect(resolveTelemetryEnv({}).OTEL_RESOURCE_ATTRIBUTES).toBe('service.version=dev,deployment.environment.name=development');
  });
});

describe('isProbeRequest', () => {
  it.each(['/api/v1/health', '/api/v1/health/ready', '/api/v1/health?x=1', '/metrics'])('%s é sonda: não gera trace', (url) => {
    expect(isProbeRequest(url)).toBe(true);
  });

  it.each(['/api/v1/patients', '/api/v1/healthcheck', '/api/v1/auth/login', '/metrics/outra', undefined])(
    '%s não é sonda: gera trace normalmente',
    (url) => {
      expect(isProbeRequest(url)).toBe(false);
    },
  );
});
