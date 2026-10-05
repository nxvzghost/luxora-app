import path from 'node:path';

/**
 * Carrega apps/backend/.env no processo do Vitest para os testes manuais.
 * Nada mais faz isso aqui: quem lê o .env na aplicação é o ConfigModule, e
 * estes testes instanciam os providers diretamente. Variável já exportada
 * no terminal continua valendo (nunca é sobrescrita).
 */
export function loadBackendEnv(): void {
  try {
    process.loadEnvFile(path.resolve(__dirname, '../../../.env'));
  } catch {
    // Sem .env local: os testes dependem só do que foi exportado no terminal.
  }
}

/** Registro do smoke — só metadados; nunca chave, token, telefone ou texto de mensagem. */
export function logSmoke(integration: string, fields: Record<string, string | number | boolean | undefined>): void {
  const line = Object.entries(fields)
    .map(([key, value]) => `${key}=${value ?? 'ausente'}`)
    .join(' ');
  // eslint-disable-next-line no-console
  console.log(`[SMOKE ${integration}] ${new Date().toISOString()} ${line}`);
}
