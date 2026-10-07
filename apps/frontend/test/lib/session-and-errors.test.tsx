import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiError, apiRequest } from '@/lib/api-client/client';
import { describeApiError, isNotFound } from '@/lib/api-client/errors';
import { roleFromToken, useSignOut } from '@/lib/session';
import { useAuthStore } from '@/lib/stores/auth.store';
import { apiError, fakeToken, mockApi } from '../support/mock-api';

/**
 * Tarefa 05 da auditoria — sessão (sair, sessão encerrada pelo servidor,
 * papel do usuário) e mensagens de erro compreensíveis.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ accessToken: null, refreshToken: null, sessionExpired: false });
});

describe('roleFromToken', () => {
  it('lê o papel gravado no access token', () => {
    expect(roleFromToken(fakeToken('admin'))).toBe('admin');
    expect(roleFromToken(fakeToken('therapist'))).toBe('therapist');
  });

  it.each([null, '', 'sem-pontos', 'a.nao-e-base64.c', `a.${btoa('{"role":"superadmin"}')}.c`])(
    'token ausente, malformado ou com papel desconhecido (%s): sem papel, nunca um erro',
    (token) => {
      expect(roleFromToken(token)).toBeNull();
    },
  );
});

describe('useSignOut — sair', () => {
  function setup() {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['patients'], { data: [{ id: 'p1', name: 'Paciente da sessão anterior' }] });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useSignOut(), { wrapper });
    return { signOut: result.current, queryClient };
  }

  beforeEach(() => {
    useAuthStore.setState({ accessToken: fakeToken('admin'), refreshToken: 'refresh-atual' });
  });

  it('encerra a sessão local, avisa o servidor com o refresh token e limpa os dados em cache', async () => {
    const api = mockApi({ 'POST /auth/logout': { status: 204 } });
    const { signOut, queryClient } = setup();

    await signOut();

    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().refreshToken).toBeNull();
    expect(useAuthStore.getState().sessionExpired).toBe(false);
    expect(api.sent('POST', '/auth/logout')[0].body).toEqual({ refreshToken: 'refresh-atual' });
    expect(queryClient.getQueryData(['patients'])).toBeUndefined();
  });

  it('servidor fora do ar: a saída local acontece do mesmo jeito', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const { signOut } = setup();

    await expect(signOut()).resolves.toBeUndefined();

    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('o aviso de saída recusado pelo servidor não dispara renovação de sessão', async () => {
    const api = mockApi({ 'POST /auth/logout': apiError(401, 'UNAUTHORIZED', 'Refresh token inválido ou expirado.') });
    const { signOut } = setup();

    await signOut();

    expect(api.sent('POST', '/auth/refresh')).toHaveLength(0);
    expect(api.requests).toHaveLength(1);
  });
});

describe('sessão encerrada pelo servidor', () => {
  it('renovação recusada marca a sessão como expirada, para a tela de login explicar o motivo', async () => {
    useAuthStore.setState({ accessToken: 'access-vencido', refreshToken: 'refresh-revogado' });
    mockApi({
      'GET /patients': apiError(401, 'UNAUTHORIZED', 'Token inválido ou expirado.'),
      'POST /auth/refresh': apiError(401, 'UNAUTHORIZED', 'Sessão encerrada ou revogada. Faça login novamente.'),
    });

    await expect(apiRequest('/patients', { token: 'access-vencido' })).rejects.toBeInstanceOf(ApiError);

    await waitFor(() => expect(useAuthStore.getState().sessionExpired).toBe(true));
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('entrar de novo limpa a marca', () => {
    useAuthStore.getState().expireSession();
    useAuthStore.getState().setTokens('novo-access', 'novo-refresh');

    expect(useAuthStore.getState().sessionExpired).toBe(false);
  });

  it('a marca não vai para o localStorage — só os dois tokens são persistidos', () => {
    useAuthStore.getState().setTokens('a', 'r');
    useAuthStore.getState().expireSession();

    const persisted = JSON.parse(localStorage.getItem('luxora-auth-storage') as string);
    expect(Object.keys(persisted.state).sort()).toEqual(['accessToken', 'refreshToken']);
  });
});

describe('describeApiError', () => {
  const fallback = 'Não foi possível concluir.';
  const error = (status: number, code = 'X', message = 'mensagem do servidor') => new ApiError(message, code, 'business_rule', status);

  it('falha de rede vira uma frase sobre conexão, não um erro técnico', () => {
    expect(describeApiError(new TypeError('fetch failed'), fallback)).toMatch(/conexão/i);
  });

  it.each([
    ['SUBSCRIPTION_INACTIVE', 403, /assinatura/i],
    ['SLOT_NOT_AVAILABLE', 409, /horário não está mais disponível/i],
    ['SESSION_CONFLICT', 409, /acabou de ocupar/i],
  ])('código %s tem explicação própria', (code, status, expected) => {
    expect(describeApiError(error(status, code), fallback)).toMatch(expected);
  });

  it('403 sem código próprio: falta de permissão do perfil', () => {
    expect(describeApiError(error(403, 'FORBIDDEN', 'Ação restrita a: admin.'), fallback)).toMatch(/perfil não tem permissão/i);
  });

  it('409 e 404 mostram a regra de negócio escrita pelo backend', () => {
    expect(describeApiError(error(409, 'CONFLICT', 'Limite de terapeutas do plano atingido.'), fallback)).toBe('Limite de terapeutas do plano atingido.');
    expect(describeApiError(error(404, 'NOT_FOUND', 'Agendamento não encontrado.'), fallback)).toBe('Agendamento não encontrado.');
  });

  it('400 (validação técnica, em inglês) cai na frase da própria ação', () => {
    expect(describeApiError(error(400, 'BAD_REQUEST', 'password must be longer than or equal to 8 characters'), fallback)).toBe(fallback);
  });

  it('erro 5xx orienta a conferir o estado antes de repetir', () => {
    expect(describeApiError(error(500, 'INTERNAL_SERVER_ERROR'), fallback)).toMatch(/atualize a página/i);
  });

  it('isNotFound distingue "ainda não existe" de uma falha', () => {
    expect(isNotFound(error(404))).toBe(true);
    expect(isNotFound(error(500))).toBe(false);
    expect(isNotFound(new TypeError('x'))).toBe(false);
  });
});
