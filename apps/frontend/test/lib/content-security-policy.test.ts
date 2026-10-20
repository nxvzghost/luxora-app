// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { apiOrigin, buildContentSecurityPolicy, createNonce } from '@/lib/content-security-policy';
import { config, middleware } from '@/middleware';

/**
 * ADR-0067 (A-17) — Content-Security-Policy do painel. Os tokens de sessão
 * ficam no localStorage: a política é o que impede um script injetado de
 * rodar e de mandá-los para outro endereço.
 */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(';').map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources] as [string, string[]];
    }),
  );
}

const production = { nonce: 'bm9uY2UtZGUtdGVzdGU=', apiUrl: 'https://api.clinica.com.br/api/v1', development: false };

describe('buildContentSecurityPolicy', () => {
  it('só aceita script com o nonce da resposta e o que ele carregar; nunca inline nem eval em produção', () => {
    const script = directives(buildContentSecurityPolicy(production)).get('script-src');
    expect(script).toEqual(["'self'", "'nonce-bm9uY2UtZGUtdGVzdGU='", "'strict-dynamic'"]);
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it('só deixa o navegador falar com a própria origem e com a origem da API', () => {
    expect(directives(buildContentSecurityPolicy(production)).get('connect-src')).toEqual([
      "'self'",
      'https://api.clinica.com.br',
    ]);
  });

  it('fecha objetos, molduras de outros sites, base e envio de formulário para fora', () => {
    const policy = directives(buildContentSecurityPolicy(production));
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'self'"]);
    expect(policy.get('form-action')).toEqual(["'self'"]);
    expect(policy.get('default-src')).toEqual(["'self'"]);
    expect(policy.get('font-src')).toEqual(["'self'"]);
  });

  it('em desenvolvimento acrescenta só o que o Next exige lá (eval e o websocket da recarga)', () => {
    const policy = directives(buildContentSecurityPolicy({ ...production, development: true }));
    expect(policy.get('script-src')).toContain("'unsafe-eval'");
    expect(policy.get('connect-src')).toContain('ws:');
  });

  it('URL da API inválida não abre a política: fica só a própria origem', () => {
    expect(apiOrigin('isto não é uma URL')).toBe('');
    expect(directives(buildContentSecurityPolicy({ ...production, apiUrl: 'isto não é uma URL' })).get('connect-src')).toEqual([
      "'self'",
    ]);
  });
});

describe('createNonce', () => {
  it('gera 128 bits em base64, diferentes a cada chamada', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => createNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(Buffer.from(nonce, 'base64')).toHaveLength(16);
    }
  });
});

describe('middleware', () => {
  it('põe a mesma política, com um nonce novo, na resposta e na requisição que segue para o Next', () => {
    const first = middleware(new NextRequest('http://localhost:3101/agenda'));
    const second = middleware(new NextRequest('http://localhost:3101/agenda'));

    const policy = first.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce).toBeTruthy();
    expect(first.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    expect(first.headers.get('x-middleware-request-content-security-policy')).toBe(policy);
    expect(second.headers.get('content-security-policy')).not.toBe(policy);
  });

  it('não roda nos arquivos estáticos nem nas licenças das fontes', () => {
    const source = new RegExp(`^${config.matcher[0].source}$`);
    expect(source.test('/agenda')).toBe(true);
    expect(source.test('/login')).toBe(true);
    expect(source.test('/_next/static/chunks/main.js')).toBe(false);
    expect(source.test('/licencas/fontes.txt')).toBe(false);
  });
});
