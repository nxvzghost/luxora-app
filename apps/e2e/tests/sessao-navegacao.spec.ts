import type { Request, Route } from '@playwright/test';
import { deactivateUser } from '../support/database';
import { expect, openMenu, signIn, test } from '../support/fixtures';

/**
 * Reprodução da sequência do trace do CI 40628166134 (1ª tentativa), com a
 * ordem das respostas fixada pelo teste: a navegação para a Agenda fica
 * pendente; uma busca da tela de Pacientes volta 401; a renovação é recusada;
 * o AuthGuard pede o login; só então a Agenda responde.
 *
 * O resultado correto é a tela de login com o aviso. O estado procurado é a
 * URL em /login com a Agenda na tela.
 */
const isAgendaNavigation = (request: Request) => {
  const url = new URL(request.url());
  const headers = request.headers();
  return url.pathname === '/agenda' && headers.rsc === '1' && !headers['next-router-prefetch'];
};

/** A ida para /login: carregamento completo da página (`window.location.replace`) ou navegação interna do Next. */
const isLoginNavigation = (request: Request) => {
  const url = new URL(request.url());
  if (url.pathname !== '/login') return false;
  if (request.isNavigationRequest()) return true;
  return request.headers().rsc === '1' && !request.headers()['next-router-prefetch'];
};

test('sessão encerrada com a navegação para a Agenda pendente: a resposta atrasada não ocupa a tela de login', async ({ page, clinic }) => {
  const heldLinked: Route[] = [];
  const heldAgenda: Route[] = [];
  const refreshes: number[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.endsWith('/auth/refresh')) refreshes.push(response.status());
  });
  const agendaFailures: string[] = [];
  page.on('requestfailed', (request) => {
    if (isAgendaNavigation(request)) agendaFailures.push(request.failure()?.errorText ?? 'sem motivo');
  });

  await signIn(page, clinic.admin);

  // Como em sessao.spec.ts: depois da desativação, o token de acesso vence —
  // invalidado a caminho da API.
  let sessionEnded = false;
  const expiredHeaders = (request: Request) => {
    const headers = request.headers();
    if (headers.authorization) headers.authorization = `${headers.authorization.slice(0, -6)}AAAAAA`;
    return headers;
  };
  await page.route('**/api/v1/**', async (route) => {
    await route.continue(sessionEnded ? { headers: expiredHeaders(route.request()) } : undefined);
  });
  await page.route('**/api/v1/contacts/linked**', async (route) => {
    if (heldLinked.length === 0) {
      heldLinked.push(route);
      return;
    }
    await route.fallback();
  });
  await openMenu(page, 'Pacientes');
  await expect.poll(() => heldLinked.length).toBe(1);

  await page.route('**/agenda?**', async (route) => {
    if (isAgendaNavigation(route.request())) {
      heldAgenda.push(route);
      return;
    }
    await route.continue();
  });
  await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: /^Agenda/ }).click();
  await expect.poll(() => heldAgenda.length).toBe(1);

  // Com a navegação pendente, o servidor encerra a sessão e a busca de
  // Pacientes que estava a caminho volta 401.
  await deactivateUser(clinic.admin.id);
  sessionEnded = true;
  const loginNavigation = page.waitForRequest(isLoginNavigation, { timeout: 15_000 });
  await heldLinked[0].continue({ headers: expiredHeaders(heldLinked[0].request()) });
  await expect.poll(() => refreshes).toEqual([401]);
  const loginRequest = await loginNavigation;
  await loginRequest.response();
  const loginKind = loginRequest.isNavigationRequest() ? 'carregamento completo' : 'navegação interna (RSC)';

  // Só agora a Agenda responde — se a requisição ainda existir (um
  // carregamento completo a cancela; isso fica registrado abaixo).
  let agendaRelease = 'liberada';
  await heldAgenda[0].continue().catch((error: Error) => {
    agendaRelease = `não liberável: ${error.message.split('\n')[0]}`;
  });
  await page.waitForLoadState('networkidle');

  const state = {
    path: new URL(page.url()).pathname,
    agendaHeadingVisible: await page.getByRole('heading', { level: 1, name: 'Agenda' }).isVisible(),
    loginButtonVisible: await page.getByRole('button', { name: 'Entrar' }).isVisible(),
    sessionNoticeVisible: await page.getByRole('status').filter({ hasText: 'Sua sessão foi encerrada' }).isVisible(),
  };
  console.log('estado final:', JSON.stringify(state), 'refresh:', refreshes);
  console.log('ida ao login:', loginKind, '| Agenda atrasada:', agendaRelease, '| falhas da Agenda no navegador:', agendaFailures);

  expect(state).toEqual({ path: '/login', agendaHeadingVisible: false, loginButtonVisible: true, sessionNoticeVisible: true });
});
