/**
 * Content-Security-Policy do painel — ADR-0067 (A-17).
 *
 * Os tokens de sessão ficam no localStorage (ADR-0061), que qualquer script
 * da página lê. Esta política é a barreira contra script injetado:
 *
 * - `script-src` só aceita script com o nonce desta resposta (gerado a cada
 *   requisição no middleware) e o que ele carregar (`'strict-dynamic'`).
 *   Script inline injetado, sem o nonce, não roda; script de outro site
 *   também não. `'unsafe-eval'` só em desenvolvimento, que o Next exige lá.
 * - `connect-src` só a própria origem e a da API: mesmo um script que rode
 *   não consegue mandar os tokens por `fetch` para outro endereço.
 * - Estilos aceitam `'unsafe-inline'`: o painel usa o atributo `style` dos
 *   componentes, e nonce não cobre atributo. Estilo não lê token.
 * - Imagens e fontes só da própria origem (as fontes são locais desde 09/10).
 */
export interface ContentSecurityPolicyOptions {
  nonce: string;
  /** URL da API (NEXT_PUBLIC_API_URL). Só a origem entra na política. */
  apiUrl: string;
  development: boolean;
}

export function apiOrigin(apiUrl: string): string {
  try {
    return new URL(apiUrl).origin;
  } catch {
    return '';
  }
}

export function buildContentSecurityPolicy({ nonce, apiUrl, development }: ContentSecurityPolicyOptions): string {
  const connect = ["'self'", apiOrigin(apiUrl)].filter(Boolean);
  if (development) connect.push('ws:');
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(development ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'"],
    'connect-src': connect,
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

/** Nonce de 128 bits em base64, novo a cada requisição. Usa só a Web Crypto, que existe no runtime do middleware. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
