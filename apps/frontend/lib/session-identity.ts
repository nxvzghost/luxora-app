/**
 * De quem é um access token: clínica, usuário e papel, que o backend grava no
 * payload. Módulo sem dependências — o cliente de API, o cache de dados e a
 * sessão o usam, e `lib/session.ts` já importa o cliente.
 *
 * Nada aqui autoriza coisa alguma: quem autoriza é o backend, em toda rota.
 * Adulterar um token no navegador não dá acesso a nada.
 */
export interface TokenPayload {
  role?: unknown;
  sub?: unknown;
  tenantId?: unknown;
}

export function tokenPayload(token: string | null): TokenPayload | null {
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as TokenPayload;
  } catch {
    return null;
  }
}

/**
 * Clínica, usuário e papel do token, em forma comparável. `null` quando o
 * token não pode ser lido ou não traz usuário e clínica.
 */
export function sessionClaims(token: string | null): string | null {
  const payload = tokenPayload(token);
  if (typeof payload?.sub !== 'string' || typeof payload.tenantId !== 'string') return null;
  return JSON.stringify([payload.tenantId, payload.sub, payload.role ?? null]);
}

/**
 * De quem é a sessão. Dois tokens da mesma sessão (o de antes e o de depois
 * de uma renovação) têm a mesma identidade; qualquer outra troca é outra
 * sessão.
 *
 * Serve para o cache de dados saber quando deixou de ser de quem o encheu
 * (`lib/query-provider.tsx`). Token que não dá para ler é a sua própria
 * identidade: na dúvida, dois tokens diferentes são duas sessões.
 */
export function sessionIdentity(token: string | null): string | null {
  if (!token) return null;
  return sessionClaims(token) ?? token;
}
