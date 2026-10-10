'use client';

import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { useAuthStore } from '@/lib/stores/auth.store';

export type Role = 'admin' | 'therapist';

/**
 * Papel do usuário, lido do próprio access token (o backend o grava no
 * payload). Serve SÓ para a interface decidir o que mostrar — um botão que o
 * perfil não pode usar não precisa aparecer. Quem autoriza de verdade é o
 * backend, em toda rota; adulterar este valor no navegador não dá acesso a nada.
 */
function tokenPayload(token: string | null): { role?: unknown; sub?: unknown; tenantId?: unknown } | null {
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { role?: unknown; sub?: unknown; tenantId?: unknown };
  } catch {
    return null;
  }
}

export function roleFromToken(token: string | null): Role | null {
  const role = tokenPayload(token)?.role;
  return role === 'admin' || role === 'therapist' ? role : null;
}

export function useRole(): Role | null {
  const token = useAuthStore((s) => s.accessToken);
  return useMemo(() => roleFromToken(token), [token]);
}

/** Id do usuário da sessão (o `sub` do token) — para a tela de usuários não oferecer "desativar" a si mesmo. */
export function useCurrentUserId(): string | null {
  const token = useAuthStore((s) => s.accessToken);
  return useMemo(() => {
    const sub = tokenPayload(token)?.sub;
    return typeof sub === 'string' ? sub : null;
  }, [token]);
}

/**
 * De quem é a sessão: clínica, usuário e papel, lidos do access token. Dois
 * tokens da mesma sessão (o de antes e o de depois de uma renovação) têm a
 * mesma identidade; qualquer outra troca é outra sessão.
 *
 * Serve para o cache de dados saber quando deixou de ser de quem o encheu
 * (`lib/query-provider.tsx`). Não autoriza nada: quem autoriza é o backend.
 *
 * Token que não dá para ler, ou sem usuário e clínica, é a sua própria
 * identidade: na dúvida, dois tokens diferentes são duas sessões.
 */
export function sessionIdentity(token: string | null): string | null {
  if (!token) return null;
  const payload = tokenPayload(token);
  if (typeof payload?.sub !== 'string' || typeof payload.tenantId !== 'string') return token;
  return JSON.stringify([payload.tenantId, payload.sub, payload.role ?? null]);
}

/**
 * Encerrar a sessão — Tarefa 05 da auditoria (o painel não tinha "Sair").
 *
 * A sessão local sai primeiro: o usuário está fora na hora, mesmo sem rede.
 * Em seguida o servidor é avisado (POST /auth/logout), o que revoga o
 * refresh token (ADR-0056) — sem isso, quem tivesse copiado o token
 * continuaria renovando a sessão por dias. Uma falha nesse aviso não
 * desfaz a saída local.
 *
 * O cache de dados é limpo junto: a próxima pessoa a entrar neste
 * navegador não pode ver, nem por um instante, os dados da anterior.
 */
export function useSignOut(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    const { refreshToken, logout } = useAuthStore.getState();
    logout();
    queryClient.clear();
    if (!refreshToken) return;
    try {
      await apiRequest('/auth/logout', { method: 'POST', body: { refreshToken } });
    } catch {
      // Sem rede ou token já inválido: localmente a sessão já acabou.
    }
  };
}
