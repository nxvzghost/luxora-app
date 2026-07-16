import { create } from 'zustand';

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  setTokens: (accessToken: string, refreshToken: string) => void;
  logout: () => void;
}

/**
 * useAuthStore — Módulo 15.
 * DÍVIDA DOCUMENTADA: tokens vivem só em memória (Zustand), perdidos a
 * cada reload de página — não há persistência real ainda (ex: cookie
 * httpOnly setado pelo Backend). Suficiente para navegação dentro de uma
 * sessão, insuficiente para uso real em produção.
 */
export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  refreshToken: null,
  setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
  logout: () => set({ accessToken: null, refreshToken: null }),
}));
