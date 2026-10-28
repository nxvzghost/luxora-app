'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/stores/auth.store';

const PUBLIC_ROUTES = ['/login'];

export type GuardDecision = 'allow' | 'wait' | 'redirect';

/**
 * resolveGuardDecision — Fase 9.1 (AD-028).
 * Função pura, extraída do componente para ser testável sem renderizar
 * nada (frontend ainda não tem @testing-library/react/jsdom instalado —
 * ver decisão registrada no relatório desta subfase).
 *
 * 'allow': libera o children (rota pública, ou rota protegida com sessão).
 * 'wait': store do Zustand ainda não reidratou do localStorage — não dá
 *   pra saber se há sessão ainda, não decide nada (evita redirecionar um
 *   usuário logado só porque a leitura do localStorage não terminou).
 * 'redirect': hidratação concluída, rota protegida, sem accessToken.
 */
export function resolveGuardDecision(params: {
  pathname: string;
  hasHydrated: boolean;
  accessToken: string | null;
}): GuardDecision {
  if (PUBLIC_ROUTES.includes(params.pathname)) return 'allow';
  if (!params.hasHydrated) return 'wait';
  return params.accessToken ? 'allow' : 'redirect';
}

/**
 * leaveForLogin — como sair de uma rota protegida para o login.
 *
 * Sessão encerrada pelo servidor: carregamento completo da página. Uma
 * navegação do painel pode estar a caminho nessa hora (o 401 costuma vir no
 * meio de um clique); a resposta dela chegava depois do login e ocupava a
 * tela com a URL já em /login — o guard libera /login e não decidia mais
 * nada (reproduzido em apps/e2e/tests/sessao-navegacao.spec.ts). Recarregar
 * descarta o estado do roteador e tudo o que estava a caminho. O aviso
 * sobrevive porque `sessionExpired` é persistido (auth.store).
 *
 * Nos outros casos ("Sair", primeira visita sem sessão), a navegação do
 * próprio Next, como antes.
 */
export function leaveForLogin(params: {
  sessionExpired: boolean;
  router: { replace: (href: string) => void };
  reload?: (href: string) => void;
}): void {
  if (params.sessionExpired) (params.reload ?? ((href) => window.location.replace(href)))('/login');
  else params.router.replace('/login');
}

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const accessToken = useAuthStore((s) => s.accessToken);
  const sessionExpired = useAuthStore((s) => s.sessionExpired);
  // Inicializa sempre false — nunca tocar em useAuthStore.persist fora de
  // useEffect: essa API só existe de forma segura no cliente. Um valor
  // inicial lido de .persist.hasHydrated() aqui (via useState(() => ...))
  // quebra o `next build` (prerender estático roda no servidor, onde
  // localStorage não existe) — achado real desta subfase.
  const [hasHydrated, setHasHydrated] = useState(false);

  useEffect(() => {
    if (useAuthStore.persist.hasHydrated()) {
      setHasHydrated(true);
      return;
    }
    return useAuthStore.persist.onFinishHydration(() => setHasHydrated(true));
  }, []);

  const decision = resolveGuardDecision({ pathname, hasHydrated, accessToken });

  useEffect(() => {
    if (decision === 'redirect') {
      leaveForLogin({ sessionExpired, router });
    }
  }, [decision, sessionExpired, router]);

  if (decision === 'allow') return <>{children}</>;
  return null;
}
