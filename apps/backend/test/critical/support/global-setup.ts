import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Etapa 2 da correção de estabilidade da Suíte Crítica — pressão de conexões
 * (causa B da investigação: 13 dos 14 arquivos de test/critical abrem 2
 * pools de conexão Prisma cada — um via bootstrapTestApp()/
 * PrismaClientProvider, role luxora_app; outro via `new PrismaClient()`
 * direto para setup/cleanup, role superuser — nenhum com connection_limit
 * configurado, cada um assumindo o default do Prisma, num_cpus*2+1).
 *
 * globalSetup roda no processo principal do Vitest, ANTES de qualquer
 * worker ser criado para esta suíte. A mutação de process.env.DATABASE_URL
 * feita aqui é herdada por todos os workers que o Vitest spawna para
 * test/critical, porque o Vitest relê process.env ao vivo no momento de
 * criar o pool de workers — depois deste setup já ter rodado, não antes.
 *
 * Só afeta test/critical, via test/critical/vitest.config.ts. O
 * DATABASE_URL de apps/backend/.env (usado por `pnpm dev`, test:unit,
 * test:integration) nunca é escrito em disco nem alterado — só o
 * process.env do processo do Vitest, apenas para esta suíte.
 *
 * process.env.DATABASE_URL NÃO está populado neste ponto por padrão: quem
 * normalmente carrega apps/backend/.env é ConfigModule.forRoot() (dotenv,
 * dentro do AppModule) — e isso só acontece dentro de bootstrapTestApp(),
 * já dentro do worker, depois deste globalSetup já ter rodado no processo
 * principal. Por isso lemos apps/backend/.env diretamente aqui (só leitura,
 * nunca escrita) quando a variável de ambiente do processo ainda não
 * existir — mesma precedência que dotenv já usa (env var real vence sobre
 * o .env, para não quebrar um CI que já exporte DATABASE_URL de verdade).
 */
function readDatabaseUrlFromEnvFile(): string {
  const envPath = path.resolve(__dirname, '../../../.env');
  const content = readFileSync(envPath, 'utf-8');
  const match = content.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/m);
  if (!match) {
    throw new Error(`DATABASE_URL não encontrado em ${envPath}`);
  }
  return match[1];
}

export function setup(): void {
  const original = process.env.DATABASE_URL ?? readDatabaseUrlFromEnvFile();

  const url = new URL(original);
  url.searchParams.set('connection_limit', '4');
  url.searchParams.set('pool_timeout', '30');
  process.env.DATABASE_URL = url.toString();

  // AD-006 — sem isto, o rate limit de POST /auth/login (padrão: 5 por
  // 60s) quebraria a Suíte Crítica inteira: praticamente todo arquivo faz
  // pelo menos 1 login real via loginAs()/createDedicatedUserAndLogin()
  // (test/critical/support/login-helper.ts, dedicated-fixture.ts), e a
  // soma de todos os 18 arquivos, rodando em paralelo (maxWorkers=6) a
  // partir do mesmo processo/IP, ultrapassa qualquer limite pensado para
  // proteção real contra força bruta. Mesmo raciocínio e mesmo mecanismo
  // já usado acima para DATABASE_URL: só afeta test/critical, nunca
  // apps/backend/.env real (usado por `pnpm dev`/test:unit/test:integration).
  // Um arquivo que precise testar o comportamento real do throttle (limite
  // baixo, 429 de fato) sobrescreve estas variáveis no próprio beforeAll,
  // antes de chamar bootstrapTestApp() — e restaura no afterAll.
  process.env.AUTH_THROTTLE_LIMIT ??= '10000';
  process.env.AUTH_THROTTLE_TTL_MS ??= '1000';

  // AD-016 — GET /metrics (MetricsAccessGuard) lança erro se
  // METRICS_ACCESS_TOKEN não estiver configurada (mesmo padrão de
  // AUTOMATION_API_KEY) — sem um valor padrão aqui, todo teste que precisar
  // acessar /metrics teria que sobrescrever a variável no próprio
  // beforeAll. Valor fixo e não-secreto, só para a Suíte Crítica.
  process.env.METRICS_ACCESS_TOKEN ??= 'critical-suite-metrics-token';

  // AD-001 — mesmo raciocínio do AUTH_THROTTLE_LIMIT acima: sem elevar o
  // limite de POST /users/bootstrap-admin, qualquer arquivo que precise
  // provisionar um Tenant novo via API (em vez do fixture direto via
  // Prisma) esbarraria no limite de produção rapidamente. Um teste que
  // precise validar o 409 de segundo bootstrap ou o rate limit de verdade
  // sobrescreve estas variáveis no próprio beforeAll, como já feito para
  // AUTH_THROTTLE_*.
  process.env.USERS_BOOTSTRAP_THROTTLE_LIMIT ??= '10000';
  process.env.USERS_BOOTSTRAP_THROTTLE_TTL_MS ??= '1000';
}
