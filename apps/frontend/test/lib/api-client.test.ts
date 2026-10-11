import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ApiError as ClientError } from '@/lib/api-client/client';

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

/**
 * O erro com que a requisição falhou, com o tipo que o cliente lança. A
 * requisição tem de falhar: se ela responder, o teste para aqui.
 */
async function rejection(request: Promise<unknown>): Promise<ClientError> {
  try {
    await request;
  } catch (error) {
    return error as ClientError;
  }
  throw new Error('a requisição deveria ter falhado');
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

    const error = await rejection(apiRequest('/patients', { token: 'a1' }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);

    expect(calls()).toHaveLength(2);
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().refreshToken).toBeNull();
  });

  it('erro 5xx no refresh não encerra a sessão: mantém os tokens e propaga o 401 original', async () => {
    const { apiRequest, useAuthStore } = await loadClient({ accessToken: 'a1', refreshToken: 'r1' });
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(jsonResponse(503));

    const error = await rejection(apiRequest('/patients', { token: 'a1' }));
    expect(error.status).toBe(401);
    expect(calls()).toHaveLength(2);
    expect(useAuthStore.getState().accessToken).toBe('a1');
    expect(useAuthStore.getState().refreshToken).toBe('r1');
  });

  it('falha de rede no refresh não encerra a sessão', async () => {
    const { apiRequest, useAuthStore } = await loadClient({ accessToken: 'a1', refreshToken: 'r1' });
    fetchMock.mockResolvedValueOnce(unauthorized()).mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const error = await rejection(apiRequest('/patients', { token: 'a1' }));
    expect(error.status).toBe(401);
    expect(useAuthStore.getState().refreshToken).toBe('r1');
  });

  it('se a repetição também receber 401, não entra em laço: uma renovação e uma repetição, nada mais', async () => {
    const { apiRequest } = await loadClient({ accessToken: 'a1', refreshToken: 'r1' });
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'a2', refreshToken: 'r2' }))
      .mockResolvedValueOnce(unauthorized());

    const error = await rejection(apiRequest('/patients', { token: 'a1' }));
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

    const error = await rejection(apiRequest('/auth/login', { method: 'POST', body: { email: 'x@y.z', password: 'errada' } }));
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

    const error = await rejection(apiRequest('/patients', { token: 'a1' }));
    expect(error.status).toBe(401);
    expect(refreshCalls()).toHaveLength(0);
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('erros que não são 401 seguem iguais, sem renovação', async () => {
    const { apiRequest, ApiError } = await loadClient({ accessToken: 'a1', refreshToken: 'r1' });
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'Sem permissão.', category: 'authorization' } }),
    );

    const error = await rejection(apiRequest('/users', { token: 'a1' }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
    expect(calls()).toHaveLength(1);
  });
});

/**
 * Tarefa 06 da auditoria (fechamento) — uma requisição pertence à sessão que
 * a enviou. O 401 de uma requisição antiga, ou uma renovação que termina
 * depois de a sessão acabar, não pode agir sobre quem está no painel agora.
 */
describe('apiRequest — entre duas sessões', () => {
  /** Access token no formato do backend: clínica, usuário e papel no payload. `issue` só muda o texto, como em uma renovação. */
  function sessionToken(sub: string, tenantId: string, issue = 1): string {
    return `header.${btoa(JSON.stringify({ sub, tenantId, role: 'admin', iat: issue }))}.signature`;
  }
  const SESSION_A = sessionToken('user-a', 'clinica-a');
  const SESSION_A_RENEWED = sessionToken('user-a', 'clinica-a', 2);
  const SESSION_B = sessionToken('user-b', 'clinica-b');

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createMemoryStorage());
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('401 atrasado de uma requisição da sessão anterior: não é renovada nem repetida com o token de quem entrou depois', async () => {
    const { apiRequest, useAuthStore } = await loadClient({ accessToken: SESSION_B, refreshToken: 'refresh-b' });
    fetchMock.mockResolvedValue(unauthorized());

    const error = await rejection(apiRequest('/clinic', { method: 'PATCH', body: { name: 'Clínica A' }, token: SESSION_A }));

    expect(error.status).toBe(401);
    expect(calls()).toHaveLength(1);
    expect(calls()[0].authorization).toBe(`Bearer ${SESSION_A}`);
    expect(useAuthStore.getState().accessToken).toBe(SESSION_B);
    expect(useAuthStore.getState().refreshToken).toBe('refresh-b');
    expect(useAuthStore.getState().sessionExpired).toBe(false);
  });

  it('depois de sair, um 401 atrasado não pede renovação nem marca a sessão como encerrada pelo servidor', async () => {
    const { apiRequest, useAuthStore } = await loadClient({ accessToken: SESSION_A, refreshToken: 'refresh-a' });
    useAuthStore.getState().logout();
    fetchMock.mockResolvedValue(unauthorized());

    const error = await rejection(apiRequest('/patients', { token: SESSION_A }));

    expect(error.status).toBe(401);
    expect(calls()).toHaveLength(1);
    expect(useAuthStore.getState().sessionExpired).toBe(false);
  });

  it('renovação que termina depois de a pessoa sair não devolve a sessão', async () => {
    const { apiRequest, useAuthStore } = await loadClient({ accessToken: SESSION_A, refreshToken: 'refresh-a' });
    const refresh = deferred<Response>();
    fetchMock.mockResolvedValueOnce(unauthorized()).mockReturnValueOnce(refresh.promise);

    const request = rejection(apiRequest('/patients', { token: SESSION_A }));
    await vi.waitFor(() => expect(refreshCalls()).toHaveLength(1));
    useAuthStore.getState().logout();
    refresh.resolve(jsonResponse(200, { accessToken: SESSION_A_RENEWED, refreshToken: 'refresh-a2' }));

    expect((await request).status).toBe(401);
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().refreshToken).toBeNull();
    expect(calls().filter((c) => c.path === '/patients')).toHaveLength(1);
  });

  it('renovação de A que termina depois de B entrar não troca a sessão de B pela de A', async () => {
    const { apiRequest, useAuthStore } = await loadClient({ accessToken: SESSION_A, refreshToken: 'refresh-a' });
    const refresh = deferred<Response>();
    fetchMock.mockResolvedValueOnce(unauthorized()).mockReturnValueOnce(refresh.promise);

    const request = rejection(apiRequest('/patients', { token: SESSION_A }));
    await vi.waitFor(() => expect(refreshCalls()).toHaveLength(1));
    useAuthStore.getState().logout();
    useAuthStore.getState().setTokens(SESSION_B, 'refresh-b');
    refresh.resolve(jsonResponse(200, { accessToken: SESSION_A_RENEWED, refreshToken: 'refresh-a2' }));

    expect((await request).status).toBe(401);
    expect(useAuthStore.getState().accessToken).toBe(SESSION_B);
    expect(useAuthStore.getState().refreshToken).toBe('refresh-b');
    expect(calls().some((c) => c.authorization === `Bearer ${SESSION_A_RENEWED}`)).toBe(false);
  });

  it('renovação de A recusada depois de B entrar não derruba a sessão de B', async () => {
    const { apiRequest, useAuthStore } = await loadClient({ accessToken: SESSION_A, refreshToken: 'refresh-a' });
    const refresh = deferred<Response>();
    fetchMock.mockResolvedValueOnce(unauthorized()).mockReturnValueOnce(refresh.promise);

    const request = rejection(apiRequest('/patients', { token: SESSION_A }));
    await vi.waitFor(() => expect(refreshCalls()).toHaveLength(1));
    useAuthStore.getState().logout();
    useAuthStore.getState().setTokens(SESSION_B, 'refresh-b');
    refresh.resolve(unauthorized());

    expect((await request).status).toBe(401);
    expect(useAuthStore.getState().accessToken).toBe(SESSION_B);
    expect(useAuthStore.getState().refreshToken).toBe('refresh-b');
    expect(useAuthStore.getState().sessionExpired).toBe(false);
  });

  it('requisição de B que pega a renovação de A em andamento nunca é repetida com o token de A', async () => {
    const { apiRequest, useAuthStore } = await loadClient({ accessToken: SESSION_A, refreshToken: 'refresh-a' });
    const refresh = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(unauthorized()) // a requisição de A
      .mockReturnValueOnce(refresh.promise) // a renovação de A, a caminho
      .mockResolvedValueOnce(unauthorized()) // a requisição de B
      .mockResolvedValue(jsonResponse(200, { data: ['dados de quem estiver no token'] }));

    const requestOfA = rejection(apiRequest('/patients', { token: SESSION_A }));
    await vi.waitFor(() => expect(refreshCalls()).toHaveLength(1));
    useAuthStore.getState().logout();
    useAuthStore.getState().setTokens(SESSION_B, 'refresh-b');
    const requestOfB = apiRequest('/billings', { token: SESSION_B }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(calls().filter((c) => c.path === '/billings')).toHaveLength(1));
    refresh.resolve(jsonResponse(200, { accessToken: SESSION_A_RENEWED, refreshToken: 'refresh-a2' }));
    await requestOfA;
    await requestOfB;

    expect(calls().some((c) => c.authorization === `Bearer ${SESSION_A_RENEWED}`)).toBe(false);
    expect(calls().filter((c) => c.path === '/billings').every((c) => c.authorization === `Bearer ${SESSION_B}`)).toBe(true);
    expect(useAuthStore.getState().accessToken).toBe(SESSION_B);
  });

  it('renovação da mesma sessão continua valendo: o token de antes e o de depois são da mesma pessoa', async () => {
    const { apiRequest, useAuthStore } = await loadClient({ accessToken: SESSION_A, refreshToken: 'refresh-a' });
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: SESSION_A_RENEWED, refreshToken: 'refresh-a2' }))
      .mockResolvedValueOnce(jsonResponse(200, { data: ['ok'] }));

    await expect(apiRequest('/patients', { token: SESSION_A })).resolves.toEqual({ data: ['ok'] });

    expect(useAuthStore.getState().accessToken).toBe(SESSION_A_RENEWED);
    expect(calls()[2].authorization).toBe(`Bearer ${SESSION_A_RENEWED}`);
  });

  it('requisição que partiu com o token antigo da mesma sessão reaproveita o token já renovado', async () => {
    const { apiRequest } = await loadClient({ accessToken: SESSION_A_RENEWED, refreshToken: 'refresh-a2' });
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    await expect(apiRequest('/patients', { token: SESSION_A })).resolves.toEqual({ data: [] });

    expect(refreshCalls()).toHaveLength(0);
    expect(calls()[1].authorization).toBe(`Bearer ${SESSION_A_RENEWED}`);
  });
});
