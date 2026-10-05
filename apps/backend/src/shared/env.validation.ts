/**
 * Validação de configuração no boot — ADR-0057 (Fase 2 da auditoria, R7).
 *
 * Ligada ao ConfigModule já existente (`ConfigModule.forRoot({ validate })`
 * em app.module.ts): roda uma vez, sobre o `.env` já mesclado com as
 * variáveis do processo. Se algo obrigatório faltar ou for inválido, lança;
 * o Nest propaga a falha ao montar os módulos (`NestFactory.create`), antes
 * de a aplicação escutar qualquer porta — o processo termina com erro.
 *
 * Antes desta validação, uma variável ausente só aparecia na primeira
 * requisição que precisasse dela (login respondendo 500 sem JWT_SECRET, por
 * exemplo), nunca no boot.
 *
 * As mensagens citam só o NOME da variável e o motivo — nunca o valor.
 *
 * Três grupos, deliberadamente distintos:
 *   1. Sempre obrigatórias, em qualquer ambiente.
 *   2. Obrigatórias só em produção. Fora dela, cada guard que depende de uma
 *      delas já falha fechado quando ela falta (responde erro, nunca libera).
 *   3. Opcionais: todo o resto. Chaves de integração (ANTHROPIC_API_KEY,
 *      ASAAS_API_KEY) e ajustes com valor padrão no código não impedem o
 *      boot; quando numéricas e presentes, precisam ser inteiros positivos.
 */
type RawEnv = Record<string, unknown>;

const MIN_SECRET_LENGTH = 32;

/** Grupo 1 — sem estas a aplicação não sobe em nenhum ambiente. */
export const ALWAYS_REQUIRED = ['DATABASE_URL', 'JWT_SECRET', 'WHATSAPP_TOKEN_ENCRYPTION_KEY'] as const;

/** Segredos que assinam (JWT) ou cifram (token do WhatsApp): tamanho mínimo em qualquer ambiente. */
const LONG_SECRETS = ['JWT_SECRET', 'WHATSAPP_TOKEN_ENCRYPTION_KEY'] as const;

/** Grupo 2 — obrigatórias quando NODE_ENV=production. */
export const REQUIRED_IN_PRODUCTION = [
  'REDIS_URL',
  'FRONTEND_URL',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'ASAAS_WEBHOOK_TOKEN',
  'AUTOMATION_API_KEY',
  'METRICS_ACCESS_TOKEN',
] as const;

/** Segredos que, em produção, não podem estar com valor de exemplo ou de teste. */
const PRODUCTION_SECRETS = [
  ...LONG_SECRETS,
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'ASAAS_WEBHOOK_TOKEN',
  'AUTOMATION_API_KEY',
  'METRICS_ACCESS_TOKEN',
] as const;

/**
 * Trechos que denunciam um valor de exemplo (`.env.example`) ou de teste
 * (CI, Suíte Crítica). Os dois são públicos — estão neste repositório.
 */
const PLACEHOLDER_MARKERS = ['troque-este-valor', 'nao-usar-em-producao'];

/** Grupo 3 — opcionais com valor padrão no código; se definidas, precisam ser inteiros positivos. */
const POSITIVE_INTEGERS = [
  'PORT',
  'AUTH_THROTTLE_LIMIT',
  'AUTH_THROTTLE_TTL_MS',
  'USERS_BOOTSTRAP_THROTTLE_LIMIT',
  'USERS_BOOTSTRAP_THROTTLE_TTL_MS',
  'JWT_SESSION_MAX_AGE_DAYS',
  'AI_PROVIDER_TIMEOUT_MS',
  'WHATSAPP_PROVIDER_TIMEOUT_MS',
  'CONTACT_CLASSIFIER_TIMEOUT_MS',
  'INBOX_STALE_CLAIM_MINUTES',
] as const;

const NODE_ENVS = ['development', 'test', 'production'];

function read(config: RawEnv, name: string): string {
  const value = config[name];
  return value === undefined || value === null ? '' : String(value).trim();
}

function databaseUser(databaseUrl: string): string | null {
  try {
    return decodeURIComponent(new URL(databaseUrl).username);
  } catch {
    return null;
  }
}

export function validateEnv(config: RawEnv): RawEnv {
  const problems: string[] = [];
  const nodeEnv = read(config, 'NODE_ENV');
  const isProduction = nodeEnv === 'production';

  if (nodeEnv && !NODE_ENVS.includes(nodeEnv)) {
    problems.push(`NODE_ENV: valor não reconhecido (use ${NODE_ENVS.join(', ')})`);
  }

  for (const name of ALWAYS_REQUIRED) {
    if (!read(config, name)) problems.push(`${name}: obrigatória e ausente`);
  }

  for (const name of LONG_SECRETS) {
    const value = read(config, name);
    if (value && value.length < MIN_SECRET_LENGTH) {
      problems.push(`${name}: precisa ter ao menos ${MIN_SECRET_LENGTH} caracteres`);
    }
  }

  const databaseUrl = read(config, 'DATABASE_URL');
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push('DATABASE_URL: precisa ser uma URL postgresql://');
  }

  for (const name of POSITIVE_INTEGERS) {
    if (config[name] === undefined || config[name] === null) continue;
    const value = read(config, name);
    if (!/^[1-9]\d*$/.test(value)) {
      problems.push(`${name}: quando definida, precisa ser um inteiro positivo`);
    }
  }

  if (isProduction) {
    for (const name of REQUIRED_IN_PRODUCTION) {
      if (!read(config, name)) problems.push(`${name}: obrigatória em produção e ausente`);
    }

    for (const name of PRODUCTION_SECRETS) {
      const value = read(config, name).toLowerCase();
      if (value && PLACEHOLDER_MARKERS.some((marker) => value.includes(marker))) {
        problems.push(`${name}: está com um valor de exemplo ou de teste, que é público — gere um segredo próprio`);
      }
    }

    // O Postgres ignora Row-Level Security para superusuário, sem erro
    // nenhum — todo o isolamento multi-tenant deixaria de valer em silêncio
    // (ver infra/docker/postgres-init/01-app-role.sql).
    if (databaseUser(databaseUrl) === 'postgres') {
      problems.push('DATABASE_URL: não pode usar o usuário "postgres" em produção (superusuário ignora Row-Level Security)');
    }
  }

  if (problems.length > 0) {
    throw new Error(
      ['Configuração de ambiente inválida — a aplicação não vai subir:', ...problems.map((problem) => `  - ${problem}`)].join('\n'),
    );
  }

  return config;
}
