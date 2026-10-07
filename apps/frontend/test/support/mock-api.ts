import { vi } from 'vitest';

/**
 * API simulada para os testes de tela da Tarefa 05.
 *
 *   const api = mockApi({
 *     'GET /patients': { body: { data: [] } },
 *     'POST /appointments/:id/cancel': (request) => ({ status: 409, body: { error: { ... } } }),
 *   });
 *   expect(api.sent('POST', '/appointments/:id/cancel')).toHaveLength(1);
 *
 * Rota não declarada responde 404 — o teste não quebra por uma consulta
 * lateral (o contador de notificações do menu, por exemplo), mas também
 * não a recebe por engano.
 */
export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
}

export interface MockReply {
  status?: number;
  body?: unknown;
}

type Route = MockReply | ((request: MockRequest) => MockReply);

function pathMatches(pattern: string, path: string): boolean {
  const regex = new RegExp(`^${pattern.replace(/:[A-Za-z]+/g, '[^/]+')}$`);
  return regex.test(path);
}

export function apiError(status: number, code: string, message: string): MockReply {
  return { status, body: { error: { code, message, category: 'business_rule' } } };
}

export function mockApi(routes: Record<string, Route>) {
  const requests: MockRequest[] = [];

  const fetchMock = vi.fn(async (input: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const url = new URL(input);
    const request: MockRequest = {
      method: init.method ?? 'GET',
      path: url.pathname.replace(/^\/api\/v1/, ''),
      query: url.searchParams,
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers ?? {},
    };
    requests.push(request);

    const key = Object.keys(routes).find((candidate) => {
      const [method, pattern] = candidate.split(' ');
      return method === request.method && pathMatches(pattern, request.path);
    });
    const route = key ? routes[key] : apiError(404, 'NOT_FOUND', `rota não simulada: ${request.method} ${request.path}`);
    const reply = typeof route === 'function' ? route(request) : route;
    const status = reply.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => reply.body };
  });

  vi.stubGlobal('fetch', fetchMock);

  return {
    fetchMock,
    requests,
    /** Requisições já feitas para um método e caminho (`:id` casa qualquer segmento). */
    sent: (method: string, pattern: string) => requests.filter((request) => request.method === method && pathMatches(pattern, request.path)),
  };
}

/** Access token falso com o papel no payload, no formato que `roleFromToken` lê. Sem assinatura válida — o teste não precisa. */
export function fakeToken(role: 'admin' | 'therapist'): string {
  return `header.${btoa(JSON.stringify({ sub: 'user-1', tenantId: 'tenant-1', role }))}.signature`;
}
