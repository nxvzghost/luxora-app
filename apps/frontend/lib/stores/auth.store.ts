import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  /**
   * Tarefa 05 — a sessão acabou sem o usuário pedir (o servidor recusou a
   * renovação: expirou, foi revogada ou o usuário foi desativado). A tela de
   * login usa isto para explicar por que a pessoa voltou para lá.
   */
  sessionExpired: boolean;
  setTokens: (accessToken: string, refreshToken: string) => void;
  /** Saída pedida pelo usuário. */
  logout: () => void;
  /** Saída imposta pelo servidor. */
  expireSession: () => void;
}

/**
 * useAuthStore — Módulo 15, ADR-0055 (AD-018) Fase 9.0 (AD-013).
 * Tokens persistidos em localStorage (zustand/middleware persist) —
 * sobrevivem a reload de página. Decisão arquitetural registrada: sem
 * proteção contra leitura via XSS (localStorage é sempre legível por JS);
 * trade-off aceito conscientemente em favor de zero alteração de contrato
 * com o backend (Bearer Token, sem cookie httpOnly).
 *
 * ADR-0056 — a renovação automática da sessão (401 → /auth/refresh) vive em
 * `lib/api-client/client.ts`, que lê e atualiza os tokens por aqui.
 *
 * Só os dois tokens vão para o localStorage (`partialize`): nada além do
 * que já era guardado passou a ser persistido.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      sessionExpired: false,
      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken, sessionExpired: false }),
      logout: () => set({ accessToken: null, refreshToken: null, sessionExpired: false }),
      expireSession: () => set({ accessToken: null, refreshToken: null, sessionExpired: true }),
    }),
    {
      name: 'luxora-auth-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ accessToken: state.accessToken, refreshToken: state.refreshToken }),
    },
  ),
);
