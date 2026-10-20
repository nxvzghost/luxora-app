import type { Route } from '@playwright/test';
import { createClinic, deactivateUser, removeClinic } from '../support/database';
import { errorMessage, expect, openMenu, signIn, test } from '../support/fixtures';

/**
 * Sessão — entrar, permanecer, sair e o que acontece quando o servidor
 * encerra a sessão. Tudo pela tela.
 */
test.describe('Sessão', () => {
  test('entra, chega ao painel e a sessão sobrevive a recarregar a página', async ({ page, clinic }) => {
    await signIn(page, clinic.admin);

    await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible();
    await expect(page.getByText('Pacientes ativos')).toBeVisible();

    await page.reload();

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByText('Pacientes ativos')).toBeVisible();
  });

  test('senha errada mostra o motivo e não entra', async ({ page, clinic }) => {
    await page.goto('/login');
    await page.locator('input[type="email"]').fill(clinic.admin.email);
    await page.locator('input[type="password"]').fill('senha-errada');
    await page.getByRole('button', { name: 'Entrar' }).click();

    await expect(errorMessage(page)).toContainText('Credenciais inválidas');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('sem sessão, uma rota protegida leva ao login', async ({ page, clinic }) => {
    // `clinic` só garante que existe um banco preparado; ninguém entra.
    void clinic;
    await page.goto('/financeiro');

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  });

  test('sair encerra a sessão e as rotas voltam a ficar protegidas', async ({ page, clinic }) => {
    await signIn(page, clinic.admin);
    await openMenu(page, 'Agenda');

    await page.getByRole('button', { name: 'Sair' }).click();

    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/agenda');
    await expect(page).toHaveURL(/\/login$/);
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: 'Agenda' })).toHaveCount(0);
  });

  test('sessão encerrada pelo servidor: uma tentativa de renovar, depois o login com o aviso', async ({ page, clinic }) => {
    // O cenário começa com a tela parada: as buscas que a entrada dispara já
    // responderam. Com a revogação imediata (ADR-0067), uma delas ainda a
    // caminho quando o usuário é desativado volta 401 e a própria página
    // encerra a sessão antes do `goto` abaixo — que recarrega e apaga o aviso,
    // guardado só em memória (CI 39366761928).
    const entryLoaded = Promise.all(
      ['/dashboard/summary', '/patients', '/notifications/unread-count'].map((path) =>
        page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(path) && response.ok()),
      ),
    );
    await signIn(page, clinic.therapistUser);
    await entryLoaded;

    // O administrador desativa o usuário enquanto ele está com o painel
    // aberto, e o token de acesso dele vence (aqui, invalidado na aba).
    await deactivateUser(clinic.therapistUser.id);
    await page.evaluate(() => {
      const key = 'luxora-auth-storage';
      const stored = JSON.parse(localStorage.getItem(key) as string);
      stored.state.accessToken = `${stored.state.accessToken.slice(0, -6)}AAAAAA`;
      localStorage.setItem(key, JSON.stringify(stored));
    });
    const refreshes: number[] = [];
    page.on('response', (response) => {
      if (response.url().endsWith('/auth/refresh')) refreshes.push(response.status());
    });

    await page.goto('/agenda');

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('status')).toContainText('Sua sessão foi encerrada');
    expect(refreshes).toEqual([401]); // uma renovação, recusada — sem laço

    // E não consegue entrar de novo.
    await page.locator('input[type="email"]').fill(clinic.therapistUser.email);
    await page.locator('input[type="password"]').fill(clinic.therapistUser.password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(errorMessage(page)).toContainText('Credenciais inválidas');
  });

  test('sair e outra clínica entrar na mesma aba: nada da primeira aparece', async ({ page, clinic }) => {
    // Sem interceptar a rede, de propósito: é o único dos três testes de duas
    // clínicas em que o cache HTTP do navegador fica ligado (o Playwright o
    // desliga quando há interceptação), e as duas pedem o mesmo endereço.
    const otherClinic = await createClinic();
    try {
      await signIn(page, clinic.admin);
      await openMenu(page, 'Pacientes');
      await expect(page.getByText(clinic.patients[0].name)).toBeVisible();

      await page.getByRole('button', { name: 'Sair' }).click();
      await expect(page).toHaveURL(/\/login$/);

      await page.locator('input[type="email"]').fill(otherClinic.admin.email);
      await page.locator('input[type="password"]').fill(otherClinic.admin.password);
      await page.getByRole('button', { name: 'Entrar' }).click();
      await expect(page).toHaveURL(/\/dashboard$/);
      await openMenu(page, 'Pacientes');

      await expect(page.getByText(otherClinic.patients[0].name)).toBeVisible();
      await expect(page.getByText(clinic.patients[0].name)).toHaveCount(0);
      await expect(page.getByText(clinic.patients[1].name)).toHaveCount(0);
    } finally {
      await removeClinic(otherClinic.tenantId);
    }
  });

  test('sessão encerrada pelo servidor: quem entra em seguida, de outra clínica, não recebe os dados da anterior', async ({ page, clinic }) => {
    const otherClinic = await createClinic();
    try {
      await signIn(page, clinic.admin);
      await openMenu(page, 'Pacientes');
      await expect(page.getByText(clinic.patients[0].name)).toBeVisible();

      // O servidor encerra a sessão com o painel aberto: o usuário é
      // desativado (a renovação passa a ser recusada) e o token de acesso
      // dele vence — aqui, invalidado a caminho da API, sem recarregar a
      // página. É a mesma aba do começo ao fim: o que estiver em memória fica.
      await deactivateUser(clinic.admin.id);
      await page.route('**/api/v1/**', async (route) => {
        const headers = route.request().headers();
        if (headers.authorization) headers.authorization = `${headers.authorization.slice(0, -6)}AAAAAA`;
        await route.continue({ headers });
      });
      await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: /^Agenda/ }).click();
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole('status')).toContainText('Sua sessão foi encerrada');
      await page.unroute('**/api/v1/**');

      // Outra pessoa, de outra clínica, entra em seguida — pelo formulário
      // que já está na tela, sem recarregar nada.
      await page.locator('input[type="email"]').fill(otherClinic.admin.email);
      await page.locator('input[type="password"]').fill(otherClinic.admin.password);
      await page.getByRole('button', { name: 'Entrar' }).click();
      await expect(page).toHaveURL(/\/dashboard$/);
      await openMenu(page, 'Pacientes');

      await expect(page.getByText(clinic.patients[0].name)).toHaveCount(0);
      await expect(page.getByText(clinic.patients[1].name)).toHaveCount(0);
      await expect(page.getByText(otherClinic.patients[0].name)).toBeVisible();
    } finally {
      await removeClinic(otherClinic.tenantId);
    }
  });

  test('resposta atrasada da sessão anterior: chega depois de outra clínica entrar e não aparece para ela', async ({ page, clinic }) => {
    const otherClinic = await createClinic();
    try {
      // A primeira busca de pacientes — a da clínica que entra primeiro; o
      // painel já a faz na tela inicial — fica a caminho: a requisição sai, a
      // resposta não volta. As outras chamadas dessa sessão seguem normais até
      // o servidor encerrá-la; daí em diante chegam com o token vencido.
      const held: Route[] = [];
      let firstSession: string | undefined;
      let sessionEnded = false;
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request();
        const headers = request.headers();
        if (held.length === 0 && request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/patients')) {
          firstSession = headers.authorization;
          held.push(route);
          return;
        }
        if (sessionEnded && headers.authorization === firstSession) headers.authorization = `${headers.authorization.slice(0, -6)}AAAAAA`;
        await route.continue({ headers });
      });
      await signIn(page, clinic.admin);
      await openMenu(page, 'Pacientes');
      await expect.poll(() => held.length).toBe(1);

      await deactivateUser(clinic.admin.id);
      sessionEnded = true;
      await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: /^Agenda/ }).click();
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole('status')).toContainText('Sua sessão foi encerrada');

      // A outra clínica entra na mesma aba e vê os pacientes dela.
      await page.locator('input[type="email"]').fill(otherClinic.admin.email);
      await page.locator('input[type="password"]').fill(otherClinic.admin.password);
      await page.getByRole('button', { name: 'Entrar' }).click();
      await expect(page).toHaveURL(/\/dashboard$/);
      await openMenu(page, 'Pacientes');
      await expect(page.getByText(otherClinic.patients[0].name)).toBeVisible();

      // Só agora a resposta retida chega — e é a de verdade, com os pacientes
      // da primeira clínica: o token de acesso dela ainda vale no servidor.
      const lateResponse = await held[0].fetch();
      expect(lateResponse.status()).toBe(200);
      expect(await lateResponse.text()).toContain(clinic.patients[0].name);
      await held[0].fulfill({ response: lateResponse });

      // Sair da tela e voltar remonta a lista a partir do cache: se a resposta
      // atrasada tivesse entrado nele, apareceria aqui.
      await openMenu(page, 'Agenda');
      await openMenu(page, 'Pacientes');
      await expect(page.getByText(otherClinic.patients[0].name)).toBeVisible();
      await expect(page.getByText(clinic.patients[0].name)).toHaveCount(0);
      await expect(page.getByText(clinic.patients[1].name)).toHaveCount(0);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await removeClinic(otherClinic.tenantId);
    }
  });

  test('token de acesso vencido com sessão válida: renova uma vez e a tela carrega', async ({ page, clinic }) => {
    await signIn(page, clinic.admin);
    await page.evaluate(() => {
      const key = 'luxora-auth-storage';
      const stored = JSON.parse(localStorage.getItem(key) as string);
      stored.state.accessToken = `${stored.state.accessToken.slice(0, -6)}AAAAAA`;
      localStorage.setItem(key, JSON.stringify(stored));
    });
    const refreshes: number[] = [];
    page.on('response', (response) => {
      if (response.url().endsWith('/auth/refresh')) refreshes.push(response.status());
    });

    await page.goto('/pacientes');

    await expect(page.getByText(clinic.patients[0].name)).toBeVisible();
    expect(refreshes).toEqual([200]);
  });

  test('perfil terapeuta não vê o que a API reserva ao administrador', async ({ page, clinic }) => {
    await signIn(page, clinic.therapistUser);

    const menu = page.getByRole('navigation', { name: 'Principal' });
    await expect(menu.getByRole('link', { name: 'Agenda', exact: true })).toBeVisible();
    for (const label of ['Usuários', 'Auditoria', 'Assinatura']) {
      await expect(menu.getByRole('link', { name: label, exact: true })).toHaveCount(0);
    }

    await page.goto('/usuarios');
    await expect(page.getByText('restrita a administradores')).toBeVisible();
  });
});
