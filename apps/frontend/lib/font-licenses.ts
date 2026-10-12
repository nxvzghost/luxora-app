import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Licenças das fontes que o painel distribui — Tarefa 07 da auditoria.
 *
 * Fraunces e Inter são servidas a partir do próprio painel
 * (`app/fonts`, ver o README de lá), sob a SIL Open Font License 1.1, que
 * pede que o aviso de direitos autorais e o texto da licença acompanhem as
 * fontes onde quer que elas sejam distribuídas. Ter os dois `OFL.txt` no
 * repositório não cobre o site nem a imagem Docker: o que chega ao navegador
 * são só os arquivos `.woff2`.
 *
 * Aqui o texto de cada licença, lido dos mesmos `OFL.txt` (uma fonte só da
 * verdade, nada copiado à mão), vira um arquivo servido pelo painel em
 * `/licencas/…` — ver `app/licencas/[arquivo]/route.ts`. Só leitura de
 * arquivo local durante o build: nenhuma rede, nenhum Google Fonts.
 */
export interface FontLicense {
  /** Nome da família, como aparece no CSS (`font-family`). */
  family: string;
  /** Onde o painel a usa. */
  usage: string;
  /** Nome do arquivo servido em `/licencas/`. */
  file: string;
  /** O `OFL.txt` da família, a partir da raiz do painel. */
  source: string;
}

export const FONT_LICENSES: readonly FontLicense[] = [
  { family: 'Fraunces', usage: 'títulos', file: 'fraunces-OFL.txt', source: 'app/fonts/fraunces/OFL.txt' },
  { family: 'Inter', usage: 'texto', file: 'inter-OFL.txt', source: 'app/fonts/inter/OFL.txt' },
];

/** O índice: qual família está sob qual licença, e onde está o texto de cada uma. */
export const FONT_LICENSES_INDEX_FILE = 'fontes.txt';
export const FONT_LICENSES_PATH = '/licencas';

/** Tudo o que `/licencas/` serve. */
export const FONT_LICENSE_FILES: readonly string[] = [FONT_LICENSES_INDEX_FILE, ...FONT_LICENSES.map((license) => license.file)];

/** O texto integral da licença, exatamente como está no `OFL.txt` da família. */
export function fontLicenseText(license: FontLicense): string {
  return readFileSync(path.join(process.cwd(), license.source), 'utf8');
}

/** O aviso de direitos autorais: a primeira linha do `OFL.txt`. */
export function fontCopyrightNotice(license: FontLicense): string {
  return fontLicenseText(license).split(/\r?\n/, 1)[0].trim();
}

export function fontLicensesIndex(): string {
  const families = FONT_LICENSES.map((license) =>
    [
      `${license.family} (${license.usage})`,
      `  Aviso de direitos autorais: ${fontCopyrightNotice(license)}`,
      '  Licença: SIL Open Font License, versão 1.1',
      `  Texto integral da licença: ${FONT_LICENSES_PATH}/${license.file}`,
    ].join('\n'),
  );
  return [
    'Fontes distribuídas com este painel',
    '===================================',
    '',
    'Os arquivos de fonte servidos em /_next/static/media/ são das duas famílias',
    'abaixo. Cada uma é distribuída sob a licença indicada, cujo texto integral',
    'acompanha o painel no endereço ao lado. Nenhuma das duas declara nome',
    'reservado, e os arquivos são servidos sem modificação.',
    '',
    families.join('\n\n'),
    '',
    'Cada arquivo de fonte traz também, nos próprios metadados, o aviso de',
    'direitos autorais e o endereço da licença.',
    '',
  ].join('\n');
}

/** O conteúdo de um arquivo de `/licencas/`, ou `null` se o nome não for de nenhum. */
export function fontLicenseFile(name: string): string | null {
  if (name === FONT_LICENSES_INDEX_FILE) return fontLicensesIndex();
  const license = FONT_LICENSES.find((candidate) => candidate.file === name);
  return license ? fontLicenseText(license) : null;
}
