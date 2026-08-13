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

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const accessToken = useAuthStore((s) => s.accessToken);
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
      router.replace('/login');
    }
  }, [decision, router]);

  if (decision === 'allow') return <>{children}</>;
  return null;
}
