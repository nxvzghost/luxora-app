import { describe, it, expect } from 'vitest';
import { resolveGuardDecision } from '../../components/auth-guard';

describe('resolveGuardDecision — Fase 9.1 (AD-028)', () => {
  it('permite /login mesmo sem hidratação concluída e sem accessToken', () => {
    expect(resolveGuardDecision({ pathname: '/login', hasHydrated: false, accessToken: null })).toBe('allow');
  });

  it('permite /login mesmo com sessão ativa (não bloqueia, só não é o alvo do guard)', () => {
    expect(resolveGuardDecision({ pathname: '/login', hasHydrated: true, accessToken: 'token-x' })).toBe('allow');
  });

  it('em rota protegida, sem hidratação concluída, aguarda (não redireciona ainda)', () => {
    expect(resolveGuardDecision({ pathname: '/agenda', hasHydrated: false, accessToken: null })).toBe('wait');
  });

  it('em rota protegida, sem hidratação concluída, aguarda mesmo que accessToken já esteja presente no estado', () => {
    expect(resolveGuardDecision({ pathname: '/agenda', hasHydrated: false, accessToken: 'token-x' })).toBe('wait');
  });

  it('em rota protegida, hidratação concluída, sem accessToken: redireciona', () => {
    expect(resolveGuardDecision({ pathname: '/agenda', hasHydrated: true, accessToken: null })).toBe('redirect');
  });

  it('em rota protegida, hidratação concluída, com accessToken: permite', () => {
    expect(resolveGuardDecision({ pathname: '/agenda', hasHydrated: true, accessToken: 'token-x' })).toBe('allow');
  });

  it('cobre múltiplas rotas protegidas distintas (dashboard, financeiro, pacientes, configuracoes)', () => {
    for (const pathname of ['/dashboard', '/financeiro', '/pacientes', '/configuracoes']) {
      expect(resolveGuardDecision({ pathname, hasHydrated: true, accessToken: null })).toBe('redirect');
      expect(resolveGuardDecision({ pathname, hasHydrated: true, accessToken: 'token-x' })).toBe('allow');
    }
  });
});
