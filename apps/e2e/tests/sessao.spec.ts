import { deactivateUser } from '../support/database';
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
    await signIn(page, clinic.therapistUser);

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
