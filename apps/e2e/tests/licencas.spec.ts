import { expect, test } from '@playwright/test';

/**
 * Tarefa 07 da auditoria — as licenças das fontes chegam junto com o painel.
 *
 * Pelo painel de verdade (build de produção, `next start`), sem login: quem
 * recebe os arquivos de fonte tem de poder ler o aviso de direitos autorais
 * e a licença de cada família.
 */
test.describe('Licenças das fontes', () => {
  test('o índice identifica a licença de cada família e os textos integrais são servidos, sem login', async ({ request }) => {
    const index = await request.get('/licencas/fontes.txt');
    expect(index.status()).toBe(200);
    expect(index.headers()['content-type']).toContain('text/plain');
    const indexText = await index.text();
    expect(indexText).toContain('Fraunces (títulos)');
    expect(indexText).toContain('Copyright 2018 The Fraunces Project Authors (https://github.com/undercasetype/Fraunces)');
    expect(indexText).toContain('Texto integral da licença: /licencas/fraunces-OFL.txt');
    expect(indexText).toContain('Inter (texto)');
    expect(indexText).toContain('Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter)');
    expect(indexText).toContain('Texto integral da licença: /licencas/inter-OFL.txt');

    for (const [file, family] of [['fraunces-OFL.txt', 'Fraunces'], ['inter-OFL.txt', 'Inter']] as const) {
      const license = await request.get(`/licencas/${file}`);
      expect(license.status()).toBe(200);
      expect(license.headers()['content-type']).toContain('text/plain');
      const text = await license.text();
      expect(text.split('\n')[0]).toContain(`The ${family} Project Authors`);
      expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
      expect(text.trimEnd().endsWith('OTHER DEALINGS IN THE FONT SOFTWARE.')).toBe(true);
    }
  });

  test('nome que não é de nenhuma licença responde 404', async ({ request }) => {
    expect((await request.get('/licencas/OFL.txt')).status()).toBe(404);
    expect((await request.get('/licencas/outra-coisa.txt')).status()).toBe(404);
  });

  test('o arquivo de fonte que a tela carrega aponta para a licença, e a tela continua igual', async ({ page, request }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();

    const fontUrls = await page.locator('link[rel="preload"][as="font"]').evaluateAll((links) => links.map((link) => (link as HTMLLinkElement).href));
    expect(fontUrls.length).toBeGreaterThan(0);
    for (const url of fontUrls) {
      expect(url).toContain('/_next/static/media/');
      const font = await request.get(url);
      expect(font.status()).toBe(200);
      expect(font.headers()['content-type']).toContain('font/woff2');
      expect(font.headers()['link']).toBe('</licencas/fontes.txt>; rel="license"');
    }

    // Nenhum pedido ao Google Fonts, e nenhum elemento novo na tela por causa das licenças.
    const external = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => /fonts\.(googleapis|gstatic)\.com/.test(name)));
    expect(external).toEqual([]);
    await expect(page.getByText(/licen[çc]a/i)).toHaveCount(0);
  });
});
