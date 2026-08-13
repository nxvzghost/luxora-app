import { describe, it, expect, beforeEach, vi } from 'vitest';

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

describe('useAuthStore — Fase 9.0 (AD-013) — persistência via localStorage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('setTokens grava accessToken/refreshToken no localStorage sob a chave luxora-auth-storage', async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);

    const { useAuthStore } = await import('../../lib/stores/auth.store');
    useAuthStore.getState().setTokens('access-123', 'refresh-456');

    const raw = storage.getItem('luxora-auth-storage');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.state.accessToken).toBe('access-123');
    expect(parsed.state.refreshToken).toBe('refresh-456');
  });

  it('uma nova instância do módulo (simulando reload) reidrata accessToken/refreshToken do localStorage', async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);

    const first = await import('../../lib/stores/auth.store');
    first.useAuthStore.getState().setTokens('access-789', 'refresh-000');

    vi.resetModules();
    const second = await import('../../lib/stores/auth.store');

    expect(second.useAuthStore.getState().accessToken).toBe('access-789');
    expect(second.useAuthStore.getState().refreshToken).toBe('refresh-000');
  });

  it('logout limpa accessToken/refreshToken tanto do estado quanto do localStorage persistido', async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);

    const { useAuthStore } = await import('../../lib/stores/auth.store');
    useAuthStore.getState().setTokens('access-x', 'refresh-y');
    useAuthStore.getState().logout();

    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().refreshToken).toBeNull();

    const raw = storage.getItem('luxora-auth-storage');
    const parsed = JSON.parse(raw as string);
    expect(parsed.state.accessToken).toBeNull();
    expect(parsed.state.refreshToken).toBeNull();
  });

  it('sem nenhum token persistido previamente, o estado inicial permanece null (comportamento pré-existente preservado)', async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);

    const { useAuthStore } = await import('../../lib/stores/auth.store');

    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().refreshToken).toBeNull();
  });
});
