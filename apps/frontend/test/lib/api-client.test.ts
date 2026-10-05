import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * ADR-0056 (Fase 2 da auditoria, R12) — renovação de sessão no cliente.
 *
 * Cobre o que `client.ts` precisa garantir ao receber um 401: uma única
 * renovação mesmo com várias requisições simultâneas, uma única repetição
 * da requisição original (nunca um laço), encerramento da sessão local só
 * quando o servidor recusa a renovação, e nenhuma renovação em rotas de
 * autenticação ou em requisições sem token.
 */

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
  };
}

function jsonResponse(status: number, body: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const unauthorized = () =>
  jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'Token inválido ou expirado.', category: 'authorization' } });

interface FetchCall {
  path: string;
  method: string;
  authorization: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

let fetchMock: ReturnType<typeof vi.fn>;

function calls(): FetchCall[] {
  return fetchMock.mock.calls.map(([url, init]) => ({
    path: String(url).replace(/^.*\/api\/v1/, ''),
    method: init?.method ?? 'GET',
    authorization: init?.headers?.Authorization,
    headers: init?.headers ?? {},
    body: init?.body ? JSON.parse(init.body) : undefined,
  }));
}

const refreshCalls = () => calls().filter((c) => c.path === '/auth/refresh');

/** Carrega store e client "do zero" — o client guarda a renovação em andamento em estado de módulo. */
async function loadClient(tokens?: { accessToken: string; refreshToken: string }) {
  const { useAuthStore } = await import('../../lib/stores/auth.store');
  const { apiRequest, ApiError } = await import('../../lib/api-client/client');
  if (tokens) useAuthStore.getState().setTokens(tokens.accessToken, tokens.refreshToken);
  return { useAuthStore, apiRequest, ApiError };
}

describe('apiRequest — renovação de sessão (ADR-0056)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createMemoryStorage());
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('requisição bem-sucedida não tenta renovar', async () => {
    const { apiRequest } = await loadClient({ accessToken: 'a1', refreshToken: 'r1' });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [1] }));

    await expect(apiRequest('/patients', { token: 'a1' })).resolves.toEqual({ data: [1] });
    expect(calls()).toHaveLength(1);
    expect(refreshCalls()).toHaveLength(0);
  });

  it('401 com sessão renovável: renova, guarda os tokens novos e repete a requisição original com o token novo', async () => {
    const { apiRequest, useAuthStore } = await loadClient({ accessToken: 'a1', refreshToken: 'r1' });
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'a2', refreshToken: 'r2' }))
      .mockResolvedValueOnce(jsonResponse(200, { data: ['ok'] }));

    await expect(apiRequest('/patients', { token: 'a1' })).resolves.toEqual({ data: ['ok'] });

    const [first, refresh, retry] = calls();
    expect(first.authorization).toBe('Bearer a1');
    expect(refresh.path).toBe('/auth/refresh');
    expect(refresh.method).toBe('POST');
    expect(refresh.body).toEqual({ refreshToken: 'r1' });
    expect(refresh.authorization).toBeUndefined();
    expect(retry.path).toBe('/patients');
    expect(retry.authorization).toBe('Bearer a2');
    expect(useAuthStore.getState().accessToken).toBe('a2');
    expect(useAuthStore.getState().refreshToken).toBe('r2');
  });

  it('a repetição preserva método, corpo e o header Idempotency-Key da requisição original', async () => {
    const { apiRequest } = await loadClient({ accessToken: 'a1', refreshToken: 'r1' });
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'a2', refreshToken: 'r2' }))
      .mockResolvedValueOnce(jsonResponse(201, { id: 'p1' }));

    await apiRequest('/payments', {
      method: 'POST',
      token: 'a1',
      body: { billingId: 'b1', amount: 100 },
      headers: { 'Idempotency-Key': 'chave-fixa' },
    });

    const [first, , retry] = calls();
    expect(retry.method).toBe('POST');
    expect(retry.body).toEqual({ billingId: 'b1', amount: 100 });
    expect(retry.headers['Idempotency-Key']).toBe('chave-fixa');
    expect(retry.headers['Idempotency-Key']).toBe(first.headers['Idempotency-Key']);
  });

  it('refresh recusado com 401 encerra a sessão local e propaga o 401, sem repetir a requisição', async () => {
    const { apiRequest, ApiError, useAuthStore } = await loadClient({ accessToken: 'a1', refreshToken: 'r1' });
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(unauthorized());

    const error = await apiRequest('/patients', { token: 'a1' }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);

    expect(calls()).toHaveLength(2);
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().refreshToken).toBeNull();
  });

  it('erro 5xx no refresh não encerra a sessão: mantém os tokens e propaga o 401 original', async () => {
    const { apiRequest, useAuthStore } = await loadClient({ accessToken: 'a1', refreshToken: 'r1' });
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(jsonResponse(503));

    const error = await apiRequest('/patients', { token: 'a1' }).catch((e) => e);
    expect(error.status).toBe(401);
    expect(calls()).toHaveLength(2);
    expect(useAuthStore.getState().accessToken).toBe('a1');
    expect(useAuthStore.getState().refreshToken).toBe('r1');
  });

  it('falha de rede no refresh não encerra a sessão', async () => {
    const { apiRequest, useAuthStore } = await loadClient({ accessToken: 'a1', refreshToken: 'r1' });
    fetchMock.mockResolvedValueOnce(unauthorized()).mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const error = await apiRequest('/patients', { token: 'a1' }).catch((e) => e);
    expect(error.status).toBe(401);
    expect(useAuthStore.getState().refreshToken).toBe('r1');
  });

  it('se a repetição também receber 401, não entra em laço: uma renovação e uma repetição, nada mais', async () => {
    const { apiRequest } = await loadClient({ accessToken: 'a1', refreshToken: 'r1' });
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'a2', refreshToken: 'r2' }))
      .mockResolvedValueOnce(unauthorized());

    const error = await apiRequest('/patients', { token: 'a1' }).catch((e) => e);
    expect(error.status).toBe(401);
    expect(calls()).toHaveLength(3);
    expect(refreshCalls()).toHaveLength(1);
  });

  it('várias requisições com 401 ao mesmo tempo geram uma única renovação, e todas são repetidas com o token novo', async () => {
    const { apiRequest } = await loadClient({ accessToken: 'a1', refreshToken: 'r1' });
    fetchMock.mockImplementation(async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
      const path = String(url).replace(/^.*\/api\/v1/, '');
      if (path === '/auth/refresh') {
        await new Promise((resolve) => setTimeout(resolve, 20)); // mantém a renovação em andamento enquanto as outras falham
        return jsonResponse(200, { accessToken: 'a2', refreshToken: 'r2' });
      }
      return init.headers.Authorization === 'Bearer a2' ? jsonResponse(200, { path }) : unauthorized();
    });

    const results = await Promise.all([
      apiRequest('/patients', { token: 'a1' }),
      apiRequest('/billings', { token: 'a1' }),
      apiRequest('/therapists', { token: 'a1' }),
    ]);

    expect(results).toEqual([{ path: '/patients' }, { path: '/billings' }, { path: '/therapists' }]);
    expect(refreshCalls()).toHaveLength(1);
    expect(calls()).toHaveLength(7); // 3 originais + 1 renovação + 3 repetições
  });

  it('se outra requisição já renovou a sessão, reaproveita o token novo do store sem pedir outra renovação', async () => {
    // O store já tem a2/r2; esta requisição ainda partiu com o token antigo a1.
    const { apiRequest } = await loadClient({ accessToken: 'a2', refreshToken: 'r2' });
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    await expect(apiRequest('/patients', { token: 'a1' })).resolves.toEqual({ data: [] });

    expect(refreshCalls()).toHaveLength(0);
    expect(calls()[1].authorization).toBe('Bearer a2');
  });

  it('rotas de autenticação nunca disparam renovação (um 401 no login é senha errada)', async () => {
    const { apiRequest } = await loadClient({ accessToken: 'a1', refreshToken: 'r1' });
    fetchMock.mockResolvedValue(unauthorized());

    const error = await apiRequest('/auth/login', { method: 'POST', body: { email: 'x@y.z', password: 'errada' } }).catch((e) => e);
    expect(error.status).toBe(401);
    expect(calls()).toHaveLength(1);
  });

  it('requisição sem token não dispara renovação', async () => {
    const { apiRequest } = await loadClient({ accessToken: 'a1', refreshToken: 'r1' });
    fetchMock.mockResolvedValue(unauthorized());

    await apiRequest('/patients').catch(() => undefined);
    expect(calls()).toHaveLength(1);
  });

  it('sem refresh token guardado: encerra a sessão local e não chama /auth/refresh', async () => {
    const { apiRequest, useAuthStore } = await loadClient();
    useAuthStore.setState({ accessToken: 'a1', refreshToken: null });
    fetchMock.mockResolvedValue(unauthorized());

    const error = await apiRequest('/patients', { token: 'a1' }).catch((e) => e);
    expect(error.status).toBe(401);
    expect(refreshCalls()).toHaveLength(0);
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('erros que não são 401 seguem iguais, sem renovação', async () => {
    const { apiRequest, ApiError } = await loadClient({ accessToken: 'a1', refreshToken: 'r1' });
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'Sem permissão.', category: 'authorization' } }),
    );

    const error = await apiRequest('/users', { token: 'a1' }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
    expect(calls()).toHaveLength(1);
  });
});
