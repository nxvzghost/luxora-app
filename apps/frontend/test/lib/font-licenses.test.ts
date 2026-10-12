// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { dynamic, dynamicParams, generateStaticParams, GET } from '@/app/licencas/[arquivo]/route';
import { FONT_LICENSE_FILES, FONT_LICENSES, fontCopyrightNotice, fontLicenseFile, fontLicensesIndex } from '@/lib/font-licenses';

/**
 * Tarefa 07 da auditoria — as licenças das fontes acompanham o painel.
 *
 * O painel distribui Fraunces e Inter (arquivos `.woff2`). A SIL Open Font
 * License pede que o aviso de direitos autorais e o texto da licença sigam
 * junto: aqui se confere que o que o painel serve em `/licencas/` é o texto
 * integral de cada `OFL.txt`, sem tirar nem pôr, e que cada família aponta
 * para a licença dela.
 */
const root = process.cwd();
const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const get = async (arquivo: string) => GET(new Request(`http://localhost/licencas/${arquivo}`), { params: Promise.resolve({ arquivo }) });

describe('licenças das fontes — o que é servido', () => {
  it('há uma licença para cada família de fonte que o painel distribui, e nenhuma família sem licença', () => {
    const familiesWithFonts = readdirSync(path.join(root, 'app/fonts'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && readdirSync(path.join(root, 'app/fonts', entry.name)).some((file) => file.endsWith('.woff2')))
      .map((entry) => entry.name)
      .sort();

    expect(familiesWithFonts).toEqual(['fraunces', 'inter']);
    expect(FONT_LICENSES.map((license) => license.source).sort()).toEqual(familiesWithFonts.map((family) => `app/fonts/${family}/OFL.txt`));
  });

  it.each(FONT_LICENSES.map((license) => [license.family, license] as const))('%s: o arquivo servido é o OFL.txt da família, byte a byte', async (_family, license) => {
    const original = readFileSync(path.join(root, license.source));

    const response = await get(license.file);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const served = Buffer.from(await response.arrayBuffer());
    expect(sha256(served)).toBe(sha256(original));
  });

  it('os textos são os que o README das fontes registra (cópias do repositório do Google Fonts)', () => {
    // SHA-256 anotados em app/fonts/README.md quando as fontes entraram no repositório.
    expect(sha256(readFileSync(path.join(root, 'app/fonts/fraunces/OFL.txt')))).toBe('bdf4c22802eaf804f998195871c6b8938aac2ac14b2d78a8bd66a6f1eced833b');
    expect(sha256(readFileSync(path.join(root, 'app/fonts/inter/OFL.txt')))).toBe('5b9321a4298cfeb6b34354164a1c3afc3db114569984c502b9b35d988fd58c57');
  });

  it.each(FONT_LICENSES.map((license) => [license.family, license] as const))('%s: aviso de direitos autorais, nome da licença e as condições, inteiros', (_family, license) => {
    const text = fontLicenseFile(license.file) ?? '';

    expect(text.split('\n')[0]).toMatch(new RegExp(`^Copyright \\d{4} The ${license.family} Project Authors`));
    expect(text).toContain('This Font Software is licensed under the SIL Open Font License, Version 1.1.');
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
    expect(text).toContain('PERMISSION & CONDITIONS');
    expect(text).toContain('TERMINATION');
    expect(text).toContain('DISCLAIMER');
    expect(text.trimEnd().endsWith('OTHER DEALINGS IN THE FONT SOFTWARE.')).toBe(true);
  });

  it('a licença de uma família não é servida no lugar da outra', () => {
    expect(fontLicenseFile('fraunces-OFL.txt')).toContain('The Fraunces Project Authors');
    expect(fontLicenseFile('fraunces-OFL.txt')).not.toContain('The Inter Project Authors');
    expect(fontLicenseFile('inter-OFL.txt')).toContain('The Inter Project Authors');
    expect(fontLicenseFile('inter-OFL.txt')).not.toContain('The Fraunces Project Authors');
  });
});

describe('licenças das fontes — o índice identifica a licença de cada família', () => {
  it('lista as duas famílias, cada uma com o seu aviso, a licença e o endereço do texto', async () => {
    const response = await get('fontes.txt');
    const index = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(index).toBe(fontLicensesIndex());
    for (const license of FONT_LICENSES) {
      const block = index.slice(index.indexOf(`${license.family} (`));
      const lines = block.split('\n').slice(0, 4);
      expect(lines[1]).toBe(`  Aviso de direitos autorais: ${fontCopyrightNotice(license)}`);
      expect(lines[2]).toBe('  Licença: SIL Open Font License, versão 1.1');
      expect(lines[3]).toBe(`  Texto integral da licença: /licencas/${license.file}`);
    }
    expect(index).toContain('/_next/static/media/');
  });

  it('os avisos vêm dos próprios OFL.txt: Fraunces 2018, Inter 2020', () => {
    expect(fontCopyrightNotice(FONT_LICENSES[0])).toBe('Copyright 2018 The Fraunces Project Authors (https://github.com/undercasetype/Fraunces)');
    expect(fontCopyrightNotice(FONT_LICENSES[1])).toBe('Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter)');
  });
});

describe('licenças das fontes — a rota', () => {
  it('é gerada no build, com exatamente os três arquivos; qualquer outro nome não existe', async () => {
    expect(dynamic).toBe('force-static');
    expect(dynamicParams).toBe(false);
    expect(generateStaticParams()).toEqual([{ arquivo: 'fontes.txt' }, { arquivo: 'fraunces-OFL.txt' }, { arquivo: 'inter-OFL.txt' }]);
    expect([...FONT_LICENSE_FILES]).toEqual(['fontes.txt', 'fraunces-OFL.txt', 'inter-OFL.txt']);

    for (const name of ['OFL.txt', '../fonts/index.ts', 'fraunces-latin.woff2', '']) {
      expect(fontLicenseFile(name)).toBeNull();
      expect((await get(name)).status).toBe(404);
    }
  });

  it('servir as licenças não consulta rede nenhuma: só lê os OFL.txt', () => {
    for (const file of ['lib/font-licenses.ts', 'app/licencas/[arquivo]/route.ts']) {
      const source = readFileSync(path.join(root, file), 'utf8');
      expect(source, file).not.toMatch(/\bfetch\(|https?:\/\//);
    }
  });

  it('nenhum arquivo do painel volta a importar next/font/google (o build não pode depender do Google Fonts)', () => {
    const sources: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
        const relative = `${directory}/${entry.name}`;
        if (entry.isDirectory()) walk(relative);
        else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) sources.push(relative);
      }
    };
    for (const directory of ['app', 'lib', 'components']) walk(directory);

    expect(sources.length).toBeGreaterThan(20);
    const importingGoogleFonts = sources.filter((file) => /from\s+['"]next\/font\/google['"]|require\(['"]next\/font\/google['"]\)/.test(readFileSync(path.join(root, file), 'utf8')));
    expect(importingGoogleFonts).toEqual([]);
  });
});
