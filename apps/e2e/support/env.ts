/**
 * Ambiente dos testes de ponta a ponta.
 *
 * Tudo aqui aponta para a pilha DESCARTÁVEL criada por infra/tests/e2e.sh
 * (Postgres e Redis próprios, em portas que não são as de desenvolvimento).
 * Nenhum valor é segredo real: são credenciais de teste, as mesmas que o CI
 * já usa para os testes críticos.
 */
export const API_PORT = Number(process.env.E2E_API_PORT ?? 3200);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3201);
export const API_URL = `http://localhost:${API_PORT}/api/v1`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

/** Conexão da aplicação: role sem privilégio, sujeita à RLS — como em produção. */
export const APP_DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://luxora_app:luxora_app_dev_pw@localhost:55432/luxora_e2e';
/** Conexão de preparação dos testes (cria e remove a clínica de cada teste). */
export const ADMIN_DATABASE_URL = process.env.E2E_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:55432/luxora_e2e';
export const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://localhost:56379';

/** A clínica dos testes fica em Brasília; navegador e backend usam o mesmo fuso, seja qual for o da máquina. */
export const CLINIC_TIMEZONE = 'America/Sao_Paulo';

/**
 * Trava de segurança: os testes criam e APAGAM dados. Recusam rodar contra
 * qualquer banco cujo nome não termine em `_e2e` — nunca o de desenvolvimento.
 */
export function assertDisposableDatabase(url: string): void {
  const database = new URL(url).pathname.replace(/^\//, '');
  if (!database.endsWith('_e2e')) {
    throw new Error(`Os testes de ponta a ponta só rodam em um banco descartável com nome terminado em "_e2e" (recebido: "${database}").`);
  }
}

/** Variáveis do backend sob teste. Integrações externas sem credencial: nenhuma chamada sai da máquina. */
export function backendEnv(): Record<string, string> {
  assertDisposableDatabase(APP_DATABASE_URL);
  return {
    NODE_ENV: 'test',
    TZ: CLINIC_TIMEZONE,
    PORT: String(API_PORT),
    DATABASE_URL: APP_DATABASE_URL,
    REDIS_URL,
    FRONTEND_URL: WEB_URL,
    JWT_SECRET: 'jwt-secret-de-teste-e2e-nao-usar-em-producao-2026',
    WHATSAPP_TOKEN_ENCRYPTION_KEY: 'chave-de-teste-e2e-nao-usar-em-producao-2026',
    WHATSAPP_APP_SECRET: 'test-app-secret',
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify-token-de-teste-e2e-nao-usar-em-producao',
    // Cada teste faz login; o limite de produção (por IP) barraria a suíte.
    AUTH_THROTTLE_LIMIT: '10000',
    AUTH_THROTTLE_TTL_MS: '1000',
    ANTHROPIC_API_KEY: '',
    ASAAS_API_KEY: '',
    OTEL_TRACES_EXPORTER: 'none',
    LOG_LEVEL: 'warn',
  };
}
