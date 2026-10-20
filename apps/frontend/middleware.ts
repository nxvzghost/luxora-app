import { NextResponse, type NextRequest } from 'next/server';
import { buildContentSecurityPolicy, createNonce } from '@/lib/content-security-policy';

/**
 * ADR-0067 (A-17) — só Content-Security-Policy. Este middleware não decide
 * nada de sessão: os tokens continuam no localStorage, fora do alcance dele,
 * e a proteção das telas continua no `AuthGuard` (ADR-0061).
 *
 * Gera um nonce por requisição e o põe no cabeçalho da requisição, de onde
 * o Next o aplica aos próprios scripts, e no da resposta, que o navegador
 * cumpre. Por isso as páginas são renderizadas a cada requisição
 * (`dynamic = 'force-dynamic'` no layout): uma página gerada no build teria
 * scripts sem o nonce.
 */
export function middleware(request: NextRequest) {
  const nonce = createNonce();
  const policy = buildContentSecurityPolicy({
    nonce,
    apiUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api/v1',
    development: process.env.NODE_ENV === 'development',
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Arquivos estáticos do build, imagens e as licenças das fontes não são páginas: não levam a política.
      source: '/((?!_next/static|_next/image|favicon.ico|licencas/).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
