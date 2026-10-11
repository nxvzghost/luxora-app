import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { AuthGuard } from '@/components/auth-guard';
import { ApiError, apiRequest } from '@/lib/api-client/client';
import { usePatients } from '@/lib/api-client/dashboard.hooks';
import { QueryProvider } from '@/lib/query-provider';
import { useSignOut } from '@/lib/session';
import { useAuthStore } from '@/lib/stores/auth.store';

/**
 * Tarefa 06 da auditoria (fechamento) — duas sessões na mesma aba não se
 * misturam, nem quando uma resposta da primeira chega depois de ela acabar.
 *
 * Tudo aqui é o painel de verdade: o provider do cache, o guard de rota, o
 * hook de pacientes e o cliente de API. Só a rede é simulada, e de um jeito
 * que deixa cada requisição "a caminho" até o teste decidir a resposta — é o
 * que permite fazer uma resposta da sessão anterior chegar atrasada. O que se
 * confere é o estado real do cache, não só o que aparece na tela.
 */

function token(sub: string, tenantId: string, role: 'admin' | 'therapist' = 'admin'): string {
  return `header.${btoa(JSON.stringify({ sub, tenantId, role }))}.signature`;
}

const SESSION_A = token('user-a', 'clinica-a');
const SESSION_B = token('user-b', 'clinica-b');
const PATIENT_A = { id: 'a1', name: 'Paciente da clínica A', phone: '+5541900000001', state: 'Ativo', billingPolicyOverride: null };
const PATIENT_B = { id: 'b1', name: 'Paciente da clínica B', phone: '+5541900000002', state: 'Ativo', billingPolicyOverride: null };
const UNAUTHORIZED = { error: { code: 'UNAUTHORIZED', message: 'Token inválido ou expirado.', category: 'authorization' } };

interface PendingRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
  respond: (status: number, body?: unknown) => void;
}

/** Rede simulada: toda requisição fica a caminho até o teste responder. */
function controllableApi() {
  const pending: PendingRequest[] = [];
  const all: PendingRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (input: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) =>
        new Promise((resolve) => {
          const request: PendingRequest = {
            method: init.method ?? 'GET',
            path: new URL(input).pathname.replace(/^\/api\/v1/, ''),
            authorization: init.headers?.Authorization,
            body: init.body ? JSON.parse(init.body) : undefined,
            respond: (status, body) => {
              pending.splice(pending.indexOf(request), 1);
              resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
            },
          };
          pending.push(request);
          all.push(request);
        }),
    ),
  );

  /** Espera a requisição chegar à rede e a devolve, ainda sem resposta. */
  async function take(path: string, sessionToken?: string): Promise<PendingRequest> {
    let found: PendingRequest | undefined;
    await waitFor(() => {
      found = pending.find((r) => r.path === path && (sessionToken === undefined || r.authorization === `Bearer ${sessionToken}`));
      expect(found, `requisição ${path} a caminho`).toBeDefined();
    });
    return found as PendingRequest;
  }

  return { take, pending, all };
}

/** Responde uma requisição e deixa o painel reagir. */
async function answer(request: PendingRequest, status: number, body?: unknown): Promise<void> {
  await act(async () => {
    request.respond(status, body);
  });
  await settle();
}

/** Deixa terminar tudo o que já estava para acontecer (promessas e uma volta do laço de eventos). */
async function settle(): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

let client: QueryClient;

function Probe() {
  client = useQueryClient();
  return null;
}

function PatientNames() {
  const { data } = usePatients();
  return (
    <ul aria-label="Pacientes">
      {(data?.data ?? []).map((patient) => (
        <li key={patient.id}>{patient.name}</li>
      ))}
    </ul>
  );
}

function SignOut() {
  const signOut = useSignOut();
  return (
    <button type="button" onClick={() => void signOut()}>
      Sair
    </button>
  );
}

/** O painel como ele é montado em `app/layout.tsx`: provider do cache por fora, guard de rota por dentro. */
function renderPanel() {
  render(
    <QueryProvider>
      <Probe />
      <AuthGuard>
        <PatientNames />
        <SignOut />
      </AuthGuard>
    </QueryProvider>,
  );
}

/** Tudo o que há de dado em qualquer consulta do cache, como texto — para procurar o que não pode estar lá. */
function everythingCached(): string {
  return JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data ?? null));
}

function signInAs(accessToken: string, refreshToken: string) {
  act(() => useAuthStore.getState().setTokens(accessToken, refreshToken));
}

/** A carrega a lista e, em seguida, uma nova busca dela fica a caminho, sem resposta. */
async function sessionAWithARequestInFlight(api: ReturnType<typeof controllableApi>): Promise<PendingRequest> {
  signInAs(SESSION_A, 'refresh-a');
  renderPanel();
  await answer(await api.take('/patients', SESSION_A), 200, { data: [PATIENT_A] });
  expect(await screen.findByText(PATIENT_A.name)).toBeInTheDocument();
  expect(client.getQueryData(['patients'])).toEqual({ data: [PATIENT_A] });

  void client.invalidateQueries({ queryKey: ['patients'] });
  return api.take('/patients', SESSION_A);
}

/** O servidor encerra a sessão de A: uma requisição recebe 401 e a renovação é recusada. Pelo cliente de verdade. */
async function serverEndsSessionA(api: ReturnType<typeof controllableApi>): Promise<void> {
  const failing = apiRequest('/clinic', { token: SESSION_A }).catch((error: unknown) => error);
  await answer(await api.take('/clinic', SESSION_A), 401, UNAUTHORIZED);
  await answer(await api.take('/auth/refresh'), 401, UNAUTHORIZED);
  expect(await failing).toBeInstanceOf(ApiError);
  expect(useAuthStore.getState().accessToken).toBeNull();
  expect(useAuthStore.getState().sessionExpired).toBe(true);
}

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ accessToken: null, refreshToken: null, sessionExpired: false });
});

describe('duas sessões na mesma aba', () => {
  it('sessão de A encerrada pelo servidor, B entra, e a resposta atrasada de A chega depois: B nunca recebe nada de A', async () => {
    const api = controllableApi();
    const lateRequestOfA = await sessionAWithARequestInFlight(api);

    await serverEndsSessionA(api);

    // Cache vazio de verdade, e nada de A na tela — antes de qualquer pessoa entrar.
    expect(everythingCached()).not.toContain(PATIENT_A.name);
    expect(client.getQueryData(['patients'])).toBeUndefined();
    expect(screen.queryByText(PATIENT_A.name)).not.toBeInTheDocument();

    // B entra na mesma instância do painel e recebe os dados dela.
    signInAs(SESSION_B, 'refresh-b');
    const sentBeforeB = api.all.length;
    await answer(await api.take('/patients', SESSION_B), 200, { data: [PATIENT_B] });
    expect(await screen.findByText(PATIENT_B.name)).toBeInTheDocument();

    // Só agora a resposta da busca antiga de A chega.
    await answer(lateRequestOfA, 200, { data: [PATIENT_A] });

    expect(screen.queryByText(PATIENT_A.name)).not.toBeInTheDocument();
    expect(screen.getByText(PATIENT_B.name)).toBeInTheDocument();
    expect(client.getQueryData(['patients'])).toEqual({ data: [PATIENT_B] });
    expect(everythingCached()).not.toContain(PATIENT_A.name);
    // Depois que B entrou, nenhuma requisição saiu com o token de A.
    expect(api.all.slice(sentBeforeB).filter((request) => request.authorization === `Bearer ${SESSION_A}`)).toHaveLength(0);
  });

  it('a resposta atrasada de A chega com o painel sem ninguém: o cache continua vazio', async () => {
    const api = controllableApi();
    const lateRequestOfA = await sessionAWithARequestInFlight(api);
    await serverEndsSessionA(api);

    await answer(lateRequestOfA, 200, { data: [PATIENT_A] });

    expect(client.getQueryData(['patients'])).toBeUndefined();
    expect(everythingCached()).not.toContain(PATIENT_A.name);
    expect(screen.queryByText(PATIENT_A.name)).not.toBeInTheDocument();
  });

  it('sair pelo botão com uma busca a caminho: a resposta que chega depois não volta para o cache, e quem entra em seguida não a recebe', async () => {
    const api = controllableApi();
    const lateRequestOfA = await sessionAWithARequestInFlight(api);

    await userEvent.click(screen.getByRole('button', { name: 'Sair' }));
    const logout = await api.take('/auth/logout');
    expect(logout.body).toEqual({ refreshToken: 'refresh-a' });
    await answer(logout, 204);

    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().sessionExpired).toBe(false);
    expect(client.getQueryData(['patients'])).toBeUndefined();

    await answer(lateRequestOfA, 200, { data: [PATIENT_A] });
    expect(everythingCached()).not.toContain(PATIENT_A.name);

    signInAs(SESSION_B, 'refresh-b');
    await answer(await api.take('/patients', SESSION_B), 200, { data: [PATIENT_B] });
    expect(await screen.findByText(PATIENT_B.name)).toBeInTheDocument();
    expect(screen.queryByText(PATIENT_A.name)).not.toBeInTheDocument();
    expect(everythingCached()).not.toContain(PATIENT_A.name);
  });

  it('a busca antiga de A recebe 401 depois de B entrar: não é refeita com o token de B, e a sessão de B segue intacta', async () => {
    const api = controllableApi();
    const lateRequestOfA = await sessionAWithARequestInFlight(api);
    await serverEndsSessionA(api);
    signInAs(SESSION_B, 'refresh-b');
    await answer(await api.take('/patients', SESSION_B), 200, { data: [PATIENT_B] });
    expect(await screen.findByText(PATIENT_B.name)).toBeInTheDocument();
    const sentSoFar = api.all.length;

    await answer(lateRequestOfA, 401, UNAUTHORIZED);

    // Nenhuma renovação e nenhuma repetição em nome de B por causa de uma requisição de A.
    expect(api.all).toHaveLength(sentSoFar);
    expect(useAuthStore.getState().accessToken).toBe(SESSION_B);
    expect(useAuthStore.getState().refreshToken).toBe('refresh-b');
    expect(useAuthStore.getState().sessionExpired).toBe(false);
    expect(client.getQueryData(['patients'])).toEqual({ data: [PATIENT_B] });
  });
});
