import { describe, it, expect } from 'vitest';
import { ConfigModule } from '@nestjs/config';
import { validateEnv, ALWAYS_REQUIRED, REQUIRED_IN_PRODUCTION } from '@shared/env.validation';

/**
 * ADR-0057 (Fase 2 da auditoria, R7) — validação de configuração no boot.
 */

const JWT_SECRET = 'segredo-jwt-de-teste-unitario-com-mais-de-32-caracteres';
const CIPHER_KEY = 'chave-de-cifra-de-teste-unitario-com-mais-de-32-caracteres';

const validDevEnv = () => ({
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://luxora_app:senha-local@localhost:5432/luxora_dev',
  JWT_SECRET,
  WHATSAPP_TOKEN_ENCRYPTION_KEY: CIPHER_KEY,
});

const validProductionEnv = () => ({
  ...validDevEnv(),
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://luxora_app:senha-de-producao@db.interno:5432/luxora',
  REDIS_URL: 'redis://redis.interno:6379',
  FRONTEND_URL: 'https://painel.exemplo.com.br',
  WHATSAPP_APP_SECRET: 'app-secret-real-da-meta-0123456789abcdef',
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify-token-proprio-0123456789abcdef',
  ASAAS_WEBHOOK_TOKEN: 'token-proprio-do-webhook-asaas-0123456789',
  AUTOMATION_API_KEY: 'chave-de-automacao-0123456789abcdef',
  METRICS_ACCESS_TOKEN: 'token-de-metricas-0123456789abcdef',
});

function errorOf(config: Record<string, unknown>): string {
  try {
    validateEnv(config);
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe('validateEnv', () => {
  describe('qualquer ambiente', () => {
    it('aceita a configuração mínima de desenvolvimento e devolve o mesmo objeto', () => {
      const config = validDevEnv();
      expect(validateEnv(config)).toBe(config);
    });

    it('aceita NODE_ENV ausente (trata como não-produção)', () => {
      const { NODE_ENV: _unused, ...config } = validDevEnv();
      expect(() => validateEnv(config)).not.toThrow();
    });

    it.each(ALWAYS_REQUIRED)('recusa quando %s está ausente', (name) => {
      const config: Record<string, unknown> = validDevEnv();
      delete config[name];
      expect(errorOf(config)).toContain(`${name}: obrigatória e ausente`);
    });

    it.each(ALWAYS_REQUIRED)('trata %s vazia ou só com espaços como ausente', (name) => {
      expect(errorOf({ ...validDevEnv(), [name]: '   ' })).toContain(`${name}: obrigatória e ausente`);
    });

    it('recusa JWT_SECRET e WHATSAPP_TOKEN_ENCRYPTION_KEY curtas demais', () => {
      const message = errorOf({ ...validDevEnv(), JWT_SECRET: 'curta', WHATSAPP_TOKEN_ENCRYPTION_KEY: 'tambem-curta' });
      expect(message).toContain('JWT_SECRET: precisa ter ao menos 32 caracteres');
      expect(message).toContain('WHATSAPP_TOKEN_ENCRYPTION_KEY: precisa ter ao menos 32 caracteres');
    });

    it('lista todos os problemas de uma vez, não só o primeiro', () => {
      const message = errorOf({ NODE_ENV: 'development' });
      for (const name of ALWAYS_REQUIRED) expect(message).toContain(name);
    });

    it('a mensagem de erro nunca contém o valor de um segredo', () => {
      const message = errorOf({
        ...validDevEnv(),
        JWT_SECRET: 'segredo-curto-123',
        DATABASE_URL: 'mysql://usuario:senha-super-secreta@host/db',
        PORT: 'porta-invalida-com-segredo-XYZ',
      });
      expect(message).not.toBe('');
      expect(message).not.toContain('segredo-curto-123');
      expect(message).not.toContain('senha-super-secreta');
      expect(message).not.toContain('porta-invalida-com-segredo-XYZ');
    });

    it('recusa DATABASE_URL que não é postgresql://', () => {
      expect(errorOf({ ...validDevEnv(), DATABASE_URL: 'mysql://u:p@host/db' })).toContain(
        'DATABASE_URL: precisa ser uma URL postgresql://',
      );
    });

    it('recusa NODE_ENV desconhecido', () => {
      expect(errorOf({ ...validDevEnv(), NODE_ENV: 'staging' })).toContain('NODE_ENV: valor não reconhecido');
    });

    it.each(['abc', '0', '-5', '1.5', ''])('recusa variável numérica opcional com valor "%s"', (value) => {
      expect(errorOf({ ...validDevEnv(), AUTH_THROTTLE_LIMIT: value })).toContain(
        'AUTH_THROTTLE_LIMIT: quando definida, precisa ser um inteiro positivo',
      );
    });

    it('aceita variáveis numéricas opcionais válidas e a ausência delas', () => {
      expect(() =>
        validateEnv({ ...validDevEnv(), PORT: '3000', AUTH_THROTTLE_LIMIT: '5', JWT_SESSION_MAX_AGE_DAYS: 30 }),
      ).not.toThrow();
    });

    it.each([
      ['LOG_FORMAT', 'xml'],
      ['LOG_LEVEL', 'barulhento'],
    ])('recusa %s com valor fora da lista ("%s")', (name, value) => {
      expect(errorOf({ ...validDevEnv(), [name]: value })).toContain(`${name}: quando definida, precisa ser um destes:`);
    });

    it('aceita LOG_FORMAT e LOG_LEVEL válidos, em qualquer caixa, e a ausência deles', () => {
      expect(() => validateEnv({ ...validDevEnv(), LOG_FORMAT: 'JSON', LOG_LEVEL: 'debug' })).not.toThrow();
      expect(() => validateEnv({ ...validDevEnv(), LOG_FORMAT: '', LOG_LEVEL: '' })).not.toThrow();
    });

    it('fora de produção, aceita o valor de exemplo do .env.example e os segredos de teste do CI', () => {
      expect(() =>
        validateEnv({
          ...validDevEnv(),
          JWT_SECRET: 'jwt-secret-de-teste-nao-usar-em-producao-2026',
          WHATSAPP_TOKEN_ENCRYPTION_KEY: 'troque-este-valor-em-todo-ambiente',
        }),
      ).not.toThrow();
    });

    it('fora de produção, não exige as variáveis de produção nem recusa o usuário postgres', () => {
      expect(() =>
        validateEnv({ ...validDevEnv(), DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/luxora_dev' }),
      ).not.toThrow();
    });
  });

  describe('produção (NODE_ENV=production)', () => {
    it('aceita uma configuração de produção completa', () => {
      expect(() => validateEnv(validProductionEnv())).not.toThrow();
    });

    it.each(REQUIRED_IN_PRODUCTION)('recusa quando %s está ausente', (name) => {
      const config: Record<string, unknown> = validProductionEnv();
      delete config[name];
      expect(errorOf(config)).toContain(`${name}: obrigatória em produção e ausente`);
    });

    it('recusa o valor de exemplo do .env.example como segredo', () => {
      const message = errorOf({ ...validProductionEnv(), JWT_SECRET: 'troque-este-valor-em-todo-ambiente' });
      expect(message).toContain('JWT_SECRET: está com um valor de exemplo ou de teste');
    });

    it('recusa os segredos de teste usados no CI', () => {
      const message = errorOf({
        ...validProductionEnv(),
        WHATSAPP_TOKEN_ENCRYPTION_KEY: 'chave-de-teste-nao-usar-em-producao-2026',
        WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify-token-de-teste-nao-usar-em-producao-2026',
      });
      expect(message).toContain('WHATSAPP_TOKEN_ENCRYPTION_KEY: está com um valor de exemplo ou de teste');
      expect(message).toContain('WHATSAPP_WEBHOOK_VERIFY_TOKEN: está com um valor de exemplo ou de teste');
    });

    it('recusa conexão com o usuário postgres (superusuário ignora Row-Level Security)', () => {
      const message = errorOf({
        ...validProductionEnv(),
        DATABASE_URL: 'postgresql://postgres:qualquer-senha@db.interno:5432/luxora',
      });
      expect(message).toContain('DATABASE_URL: não pode usar o usuário "postgres" em produção');
    });
  });

  describe('integração com o ConfigModule', () => {
    // Em @nestjs/config 3.x, forRoot() é assíncrono: a falha de validação
    // chega como promessa rejeitada, que o Nest aguarda ao montar os módulos
    // (NestFactory.create) — antes de a aplicação escutar qualquer porta.
    it('ConfigModule.forRoot({ validate }) rejeita quando falta uma variável obrigatória', async () => {
      const saved = process.env.JWT_SECRET;
      delete process.env.JWT_SECRET;
      try {
        await expect(
          (async () => ConfigModule.forRoot({ ignoreEnvFile: true, validate: validateEnv }))(),
        ).rejects.toThrow(/JWT_SECRET: obrigatória e ausente/);
      } finally {
        if (saved !== undefined) process.env.JWT_SECRET = saved;
      }
    });
  });
});
