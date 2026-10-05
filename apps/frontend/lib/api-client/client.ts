import { useAuthStore } from '@/lib/stores/auth.store';

/**
 * apiClient — Módulo 15.
 *
 * Único lugar que fala com o Backend via fetch. Todo erro é normalizado
 * para o formato oficial já implementado no Backend (Módulo 08,
 * LuxoraExceptionFilter): { error: { code, message, category, timestamp } }.
 *
 * ADR-0056 (Fase 2 da auditoria, R12) — renovação de sessão. O access token
 * dura 15 minutos; sem tratar o 401, toda tela passava a falhar depois desse
 * prazo com o usuário ainda "logado". Agora um 401 numa requisição
 * autenticada dispara UMA renovação (compartilhada por todas as requisições
 * que falharem ao mesmo tempo) e a requisição original é repetida UMA vez.
 * Se o servidor recusar a renovação, a sessão local é encerrada e o
 * AuthGuard leva o usuário ao login.
 */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api/v1';

/** Rotas de autenticação nunca disparam renovação: um 401 nelas é a própria resposta (senha errada, refresh recusado). */
const AUTH_PATH_PREFIX = '/auth/';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly category: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  token?: string | null;
  /** Fase 9.4 (AD-020) — necessário para o header Idempotency-Key exigido por POST /payments (RNF-008). Aditivo, opcional. */
  headers?: Record<string, string>;
}

function send(path: string, options: RequestOptions, token: string | null | undefined): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

/** Renovação em andamento, compartilhada: N requisições com 401 ao mesmo tempo geram uma única chamada a /auth/refresh. */
let refreshInFlight: Promise<string | null> | null = null;

/**
 * Devolve o novo access token, ou `null` quando não foi possível renovar.
 *
 * Só um 401 do próprio /auth/refresh encerra a sessão local — é o servidor
 * dizendo que ela foi revogada, expirou ou o usuário foi desativado. Falha
 * de rede ou erro 5xx não prova nada sobre a sessão: os tokens são
 * mantidos e quem chamou recebe o erro original.
 */
async function renewSession(): Promise<string | null> {
  const { refreshToken, setTokens, logout } = useAuthStore.getState();
  if (!refreshToken) {
    logout();
    return null;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!response.ok) {
      if (response.status === 401) logout();
      return null;
    }

    const tokens = (await response.json()) as { accessToken: string; refreshToken: string };
    setTokens(tokens.accessToken, tokens.refreshToken);
    return tokens.accessToken;
  } catch {
    return null;
  }
}

function renewSessionOnce(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = renewSession().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * Token para repetir uma requisição que recebeu 401. Se outra requisição já
 * renovou a sessão enquanto esta estava em trânsito, o store já tem um
 * access token mais novo que o usado aqui — basta reaproveitá-lo, sem pedir
 * outra renovação.
 */
function tokenForRetry(usedToken: string): Promise<string | null> {
  const current = useAuthStore.getState().accessToken;
  if (current && current !== usedToken) return Promise.resolve(current);
  return renewSessionOnce();
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response = await send(path, options, options.token);

  // Repetir é seguro para qualquer método: o 401 vem do guard de
  // autenticação, antes de a requisição chegar ao handler — nada foi
  // executado no servidor. Uma única repetição, nunca um laço.
  if (response.status === 401 && options.token && !path.startsWith(AUTH_PATH_PREFIX)) {
    const renewedToken = await tokenForRetry(options.token);
    if (renewedToken) {
      response = await send(path, options, renewedToken);
    }
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    const error = errorBody?.error;
    throw new ApiError(
      error?.message ?? 'Erro inesperado ao comunicar com o servidor.',
      error?.code ?? 'UNKNOWN_ERROR',
      error?.category ?? 'system',
      response.status,
    );
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
