/**
 * apiClient — Módulo 15.
 *
 * Único lugar que fala com o Backend via fetch. Todo erro é normalizado
 * para o formato oficial já implementado no Backend (Módulo 08,
 * LuxoraExceptionFilter): { error: { code, message, category, timestamp } }.
 */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api/v1';

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

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

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
