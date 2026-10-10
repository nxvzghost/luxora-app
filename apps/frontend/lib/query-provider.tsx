'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { sessionIdentity } from '@/lib/session';
import { useAuthStore } from '@/lib/stores/auth.store';

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } }));

  // Os dados em cache são de UMA sessão. As chaves das consultas não levam
  // clínica nem usuário (['patients'], ['billings']…): o que uma sessão
  // buscou seria entregue à seguinte, na mesma aba, sem chamada à API.
  //
  // O cache é esvaziado sempre que a sessão deixa de ser da mesma pessoa:
  // saída, sessão encerrada pelo servidor (renovação recusada — caminho que
  // não passa pelo botão "Sair") e entrada de outro usuário, clínica ou
  // papel. Renovar o token da mesma sessão não esvazia nada.
  useEffect(
    () =>
      useAuthStore.subscribe((state, previous) => {
        if (sessionIdentity(state.accessToken) !== sessionIdentity(previous.accessToken)) client.clear();
      }),
    [client],
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
