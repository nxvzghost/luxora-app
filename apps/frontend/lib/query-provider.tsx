'use client';

import { hashKey, QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { sessionIdentity } from '@/lib/session-identity';
import { useAuthStore } from '@/lib/stores/auth.store';

/**
 * O cliente de dados do painel.
 *
 * Segunda linha de defesa do cache (a primeira é esvaziá-lo, abaixo): a
 * identidade da sessão entra na chave interna de toda consulta. O código
 * continua escrevendo `['patients']`; guardado, vira "`['patients']` da
 * clínica, usuário e papel de agora". Mesmo que algum caminho deixe de
 * limpar o cache, uma sessão não encontra o que outra guardou. É feito aqui,
 * em um lugar só, para nenhum hook precisar lembrar de pôr a sessão na chave.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        queryKeyHashFn: (queryKey: QueryKey) => hashKey([sessionIdentity(useAuthStore.getState().accessToken), ...queryKey]),
      },
    },
  });
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(createQueryClient);

  // Os dados em cache são de UMA sessão. As chaves das consultas não levam
  // clínica nem usuário (['patients'], ['billings']…): o que uma sessão
  // buscou seria entregue à seguinte, na mesma aba, sem chamada à API.
  //
  // O cache é esvaziado sempre que a sessão deixa de ser da mesma pessoa:
  // saída, sessão encerrada pelo servidor (renovação recusada — caminho que
  // não passa pelo botão "Sair") e entrada de outro usuário, clínica ou
  // papel. Renovar o token da mesma sessão não esvazia nada.
  //
  // `clear()` destrói cada consulta, o que também descarta a resposta das
  // buscas que ainda estavam a caminho: quando ela chega, não há mais onde
  // gravá-la (conferido em test/lib/session-isolation.test.tsx).
  useEffect(
    () =>
      useAuthStore.subscribe((state, previous) => {
        if (sessionIdentity(state.accessToken) !== sessionIdentity(previous.accessToken)) client.clear();
      }),
    [client],
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
