import { defineConfig, devices } from '@playwright/test';
import { API_URL, CLINIC_TIMEZONE, WEB_PORT, WEB_URL, backendEnv } from './support/env';

/**
 * Testes de ponta a ponta do painel — Tarefa 06 da auditoria (AD-012).
 *
 * O Playwright sobe o backend e o painel JÁ CONSTRUÍDOS e os derruba no
 * fim. Banco, Redis, migrations e os dois builds são preparados por
 * infra/tests/e2e.sh, que é o jeito de rodar a suíte (local e no CI):
 *
 *   bash infra/tests/e2e.sh
 *
 * Sem repetição automática: um teste instável tem de aparecer como falha,
 * não ser escondido por uma segunda tentativa.
 */
export default defineConfig({
  testDir: './tests',
  globalTeardown: './support/global-teardown.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 2,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: WEB_URL,
    locale: 'pt-BR',
    timezoneId: CLINIC_TIMEZONE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node dist/main.js',
      cwd: '../backend',
      url: `${API_URL}/health/ready`,
      env: backendEnv(),
      reuseExistingServer: false,
      timeout: 90_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `npx next start -p ${WEB_PORT}`,
      cwd: '../frontend',
      url: `${WEB_URL}/login`,
      reuseExistingServer: false,
      timeout: 90_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
