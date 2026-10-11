import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ApiError, apiRequest } from '@/lib/api-client/client';
import { createQueryClient, QueryProvider } from '@/lib/query-provider';
import { sessionIdentity } from '@/lib/session-identity';
import { useAuthStore } from '@/lib/stores/auth.store';
import { apiError, mockApi } from '../support/mock-api';

/**
 * Tarefa 06 da auditoria (fechamento) — os dados em cache são de UMA sessão.
 *
 * As chaves das consultas não levam clínica nem usuário (`['patients']`,
 * `['billings']`…). Se o cache sobrevive ao fim de uma sessão, a pessoa que
 * entra em seguida na mesma aba recebe, sem nenhuma chamada à API, o que a
 * anterior buscou — de outra clínica, ou de um papel com mais acesso.
 *
 * O botão "Sair" já limpava o cache (Tarefa 05). O caminho que faltava é o
 * da sessão encerrada pelo servidor, que não passa pelo botão.
 */

function token(sub: string, tenantId: string, role: 'admin' | 'therapist' = 'admin', issue = 1): string {
  // `issue` só muda o texto do token: é o que acontece em uma renovação.
  return `header.${btoa(JSON.stringify({ sub, tenantId, role, iat: issue }))}.signature`;
}

const CACHED = { data: [{ id: 'p1', name: 'Paciente da sessão anterior' }] };

/** Monta o provider de verdade, entra com `accessToken` e deixa uma consulta em cache, como se a tela já tivesse buscado. */
function sessionWithCachedData(accessToken: string): QueryClient {
  let client: QueryClient | undefined;
  function Probe() {
    client = useQueryClient();
    return null;
  }
  useAuthStore.getState().setTokens(accessToken, 'refresh-atual');
  render(
    <QueryProvider>
      <Probe />
    </QueryProvider>,
  );
  if (!client) throw new Error('o provider não montou');
  client.setQueryData(['patients'], CACHED);
  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ accessToken: null, refreshToken: null, sessionExpired: false });
});

describe('QueryProvider — o cache não passa de uma sessão para a outra', () => {
  it('sessão encerrada pelo servidor (renovação recusada): os dados em cache somem', async () => {
    const accessToken = token('user-a', 'clinica-a');
    const client = sessionWithCachedData(accessToken);
    mockApi({
      'GET /patients': apiError(401, 'UNAUTHORIZED', 'Token inválido ou expirado.'),
      'POST /auth/refresh': apiError(401, 'UNAUTHORIZED', 'Sessão encerrada ou revogada. Faça login novamente.'),
    });

    await expect(apiRequest('/patients', { token: accessToken })).rejects.toBeInstanceOf(ApiError);

    await waitFor(() => expect(useAuthStore.getState().sessionExpired).toBe(true));
    expect(client.getQueryData(['patients'])).toBeUndefined();
  });

  it('sair limpa o cache mesmo sem passar pelo botão (a regra vale para qualquer fim de sessão)', () => {
    const client = sessionWithCachedData(token('user-a', 'clinica-a'));

    useAuthStore.getState().logout();

    expect(client.getQueryData(['patients'])).toBeUndefined();
  });

  it('outra clínica entra por cima da sessão, sem saída no meio: nada da anterior fica', () => {
    const client = sessionWithCachedData(token('user-a', 'clinica-a'));

    useAuthStore.getState().setTokens(token('user-b', 'clinica-b'), 'refresh-b');

    expect(client.getQueryData(['patients'])).toBeUndefined();
  });

  it('outro usuário da mesma clínica: nada da anterior fica', () => {
    const client = sessionWithCachedData(token('user-a', 'clinica-a', 'admin'));

    useAuthStore.getState().setTokens(token('user-b', 'clinica-a', 'therapist'), 'refresh-b');

    expect(client.getQueryData(['patients'])).toBeUndefined();
  });

  it('o mesmo usuário com outro papel: o que o papel anterior buscou não fica', () => {
    const client = sessionWithCachedData(token('user-a', 'clinica-a', 'admin'));

    useAuthStore.getState().setTokens(token('user-a', 'clinica-a', 'therapist'), 'refresh-novo');

    expect(client.getQueryData(['patients'])).toBeUndefined();
  });

  it('token ilegível: na dúvida, a troca de token é tratada como troca de sessão', () => {
    const client = sessionWithCachedData('token-que-nao-e-jwt');

    useAuthStore.getState().setTokens('outro-token-que-nao-e-jwt', 'refresh-novo');

    expect(client.getQueryData(['patients'])).toBeUndefined();
  });

  it('renovação da mesma sessão (token novo, mesma pessoa, clínica e papel): o cache fica', () => {
    const client = sessionWithCachedData(token('user-a', 'clinica-a', 'admin', 1));

    useAuthStore.getState().setTokens(token('user-a', 'clinica-a', 'admin', 2), 'refresh-renovado');

    expect(client.getQueryData(['patients'])).toEqual(CACHED);
  });

  it('desmontado, o provider para de ouvir a sessão', () => {
    let client: QueryClient | undefined;
    function Probe() {
      client = useQueryClient();
      return null;
    }
    useAuthStore.getState().setTokens(token('user-a', 'clinica-a'), 'refresh-atual');
    const { unmount } = render(
      <QueryProvider>
        <Probe />
      </QueryProvider>,
    );
    client?.setQueryData(['patients'], CACHED);

    unmount();
    useAuthStore.getState().logout();

    // Olha o cache em si, não uma busca pela chave: sem sessão a chave já é
    // outra (segunda linha, abaixo). O que se prova é que ninguém o esvaziou.
    expect(client?.getQueryCache().getAll().map((query) => query.state.data)).toEqual([CACHED]);
  });
});

describe('createQueryClient — segunda linha: cada sessão tem as suas próprias chaves', () => {
  // Sem provider montado: ninguém limpa o cache aqui. É a chave que separa.
  const OTHER = { data: [{ id: 'p2', name: 'Paciente de outra sessão' }] };

  it('o que uma sessão guardou não é encontrado pela seguinte, mesmo que ninguém limpe o cache', () => {
    const client = createQueryClient();
    useAuthStore.getState().setTokens(token('user-a', 'clinica-a'), 'refresh-a');
    client.setQueryData(['patients'], CACHED);

    useAuthStore.getState().setTokens(token('user-b', 'clinica-b'), 'refresh-b');

    expect(client.getQueryData(['patients'])).toBeUndefined();
    client.setQueryData(['patients'], OTHER);
    expect(client.getQueryData(['patients'])).toEqual(OTHER);

    // De volta à primeira identidade, o dado dela está onde foi deixado: nada foi apagado, a chave é que é outra.
    useAuthStore.getState().setTokens(token('user-a', 'clinica-a'), 'refresh-a');
    expect(client.getQueryData(['patients'])).toEqual(CACHED);
  });

  it('sem sessão, nada do que uma sessão guardou é encontrado', () => {
    const client = createQueryClient();
    useAuthStore.getState().setTokens(token('user-a', 'clinica-a'), 'refresh-a');
    client.setQueryData(['patients'], CACHED);

    useAuthStore.setState({ accessToken: null, refreshToken: null });

    expect(client.getQueryData(['patients'])).toBeUndefined();
  });

  it('renovar o token da mesma sessão não muda a chave', () => {
    const client = createQueryClient();
    useAuthStore.getState().setTokens(token('user-a', 'clinica-a', 'admin', 1), 'refresh-a');
    client.setQueryData(['patients'], CACHED);

    useAuthStore.getState().setTokens(token('user-a', 'clinica-a', 'admin', 2), 'refresh-a2');

    expect(client.getQueryData(['patients'])).toEqual(CACHED);
  });

  it('invalidar pela chave do código continua alcançando as consultas da sessão atual', async () => {
    const client = createQueryClient();
    useAuthStore.getState().setTokens(token('user-a', 'clinica-a'), 'refresh-a');
    client.setQueryData(['patients'], CACHED);
    client.setQueryData(['appointments', '2031-01-01'], CACHED);

    await client.invalidateQueries({ queryKey: ['patients'] });

    expect(client.getQueryState(['patients'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['appointments', '2031-01-01'])?.isInvalidated).toBe(false);
  });
});

describe('sessionIdentity', () => {
  it('é a mesma para dois tokens da mesma pessoa, clínica e papel', () => {
    expect(sessionIdentity(token('u', 'c', 'admin', 1))).toBe(sessionIdentity(token('u', 'c', 'admin', 2)));
  });

  it('muda com o usuário, com a clínica e com o papel', () => {
    const base = sessionIdentity(token('u', 'c', 'admin'));
    expect(sessionIdentity(token('outro', 'c', 'admin'))).not.toBe(base);
    expect(sessionIdentity(token('u', 'outra', 'admin'))).not.toBe(base);
    expect(sessionIdentity(token('u', 'c', 'therapist'))).not.toBe(base);
  });

  it('sem token não há sessão', () => {
    expect(sessionIdentity(null)).toBeNull();
  });

  it('token ilegível ou sem usuário e clínica: cada token é uma sessão própria, nunca um erro', () => {
    expect(sessionIdentity('sem-pontos')).toBe('sem-pontos');
    expect(sessionIdentity('a.nao-e-base64.c')).toBe('a.nao-e-base64.c');
    const semClinica = `a.${btoa(JSON.stringify({ sub: 'u' }))}.c`;
    expect(sessionIdentity(semClinica)).toBe(semClinica);
  });
});
