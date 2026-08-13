import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  setTokens: (accessToken: string, refreshToken: string) => void;
  logout: () => void;
}

/**
 * useAuthStore — Módulo 15, ADR-0055 (AD-018) Fase 9.0 (AD-013).
 * Tokens persistidos em localStorage (zustand/middleware persist) —
 * sobrevivem a reload de página. Decisão arquitetural registrada: sem
 * refresh automático (fora de escopo desta subfase) e sem proteção contra
 * leitura via XSS (localStorage é sempre legível por JS); trade-off aceito
 * conscientemente em favor de zero alteração de contrato com o backend
 * (Bearer Token, sem cookie httpOnly).
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
      logout: () => set({ accessToken: null, refreshToken: null }),
    }),
    {
      name: 'luxora-auth-storage',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
