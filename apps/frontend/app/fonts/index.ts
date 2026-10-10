import localFont from 'next/font/local';

/**
 * Fontes do painel — Fraunces (títulos) e Inter (texto), servidas a partir
 * de arquivos do próprio repositório.
 *
 * Antes vinham de `next/font/google`, que baixa as fontes do Google Fonts
 * DURANTE o build. O build do painel passou a falhar no CI quando o Google
 * devolveu a alguns runners uma resposta que esta versão do Next não trata
 * (`TypeError: Cannot read properties of null (reading '1')`). Com os
 * arquivos aqui, o build não consulta rede nenhuma.
 *
 * O QUE ESTÁ AQUI É O QUE O BUILD ANTERIOR JÁ EMBUTIA — os mesmos dez
 * arquivos, byte a byte, com as mesmas faces:
 *
 * - um arquivo por subconjunto de caracteres, cada um limitado à sua faixa
 *   (`unicode-range`): o navegador só baixa o subconjunto que a página usa;
 * - Fraunces: fonte variável no peso, declarada nos pesos 400, 500 e 600;
 * - Inter: fonte variável no peso, de 100 a 900;
 * - só os subconjuntos "latin" são pré-carregados, como antes.
 *
 * Cada subconjunto é uma chamada porque `unicode-range` vale para todas as
 * faces de uma chamada. As chamadas da mesma fonte declaram a mesma
 * `font-family`, então o navegador as vê como uma família só — é o nome que
 * `globals.css` usa em `--font-display` e `--font-body`. A ordem das
 * chamadas é a do CSS do Google e não deve mudar: quando duas faixas se
 * sobrepõem, vale a face declarada por último.
 *
 * `variable` existe para que cada chamada gere uma classe, aplicada no
 * <html> como o layout já fazia com as fontes do Google — é a forma
 * documentada de ligar uma fonte do `next/font` à página. O valor da
 * variável em si não é lido por ninguém: o nome da família vem de
 * `globals.css`.
 *
 * `adjustFontFallback: false`: as fontes de reserva continuam sendo as de
 * `globals.css` (Georgia e a sans-serif do sistema), como já eram na prática.
 *
 * Origem, versão, licença (SIL OFL 1.1) e conferência de cada arquivo:
 * ./README.md.
 */

// ---------------------------------------------------------------- Fraunces

const frauncesVietnamese = localFont({
  src: [
    { path: './fraunces/fraunces-vietnamese.woff2', weight: '400', style: 'normal' },
    { path: './fraunces/fraunces-vietnamese.woff2', weight: '500', style: 'normal' },
    { path: './fraunces/fraunces-vietnamese.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  variable: '--font-fraunces',
  declarations: [
    { prop: 'font-family', value: 'Fraunces' },
    {
      prop: 'unicode-range',
      value:
        'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB',
    },
  ],
});

const frauncesLatinExt = localFont({
  src: [
    { path: './fraunces/fraunces-latin-ext.woff2', weight: '400', style: 'normal' },
    { path: './fraunces/fraunces-latin-ext.woff2', weight: '500', style: 'normal' },
    { path: './fraunces/fraunces-latin-ext.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  variable: '--font-fraunces',
  declarations: [
    { prop: 'font-family', value: 'Fraunces' },
    {
      prop: 'unicode-range',
      value:
        'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF',
    },
  ],
});

const frauncesLatin = localFont({
  src: [
    { path: './fraunces/fraunces-latin.woff2', weight: '400', style: 'normal' },
    { path: './fraunces/fraunces-latin.woff2', weight: '500', style: 'normal' },
    { path: './fraunces/fraunces-latin.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap',
  preload: true,
  adjustFontFallback: false,
  variable: '--font-fraunces',
  declarations: [
    { prop: 'font-family', value: 'Fraunces' },
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
});

// ------------------------------------------------------------------- Inter

const interCyrillicExt = localFont({
  src: './inter/inter-cyrillic-ext.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  variable: '--font-inter',
  declarations: [
    { prop: 'font-family', value: 'Inter' },
    { prop: 'unicode-range', value: 'U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F' },
  ],
});

const interCyrillic = localFont({
  src: './inter/inter-cyrillic.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  variable: '--font-inter',
  declarations: [
    { prop: 'font-family', value: 'Inter' },
    { prop: 'unicode-range', value: 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116' },
  ],
});

const interGreekExt = localFont({
  src: './inter/inter-greek-ext.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  variable: '--font-inter',
  declarations: [
    { prop: 'font-family', value: 'Inter' },
    { prop: 'unicode-range', value: 'U+1F00-1FFF' },
  ],
});

const interGreek = localFont({
  src: './inter/inter-greek.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  variable: '--font-inter',
  declarations: [
    { prop: 'font-family', value: 'Inter' },
    { prop: 'unicode-range', value: 'U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF' },
  ],
});

const interVietnamese = localFont({
  src: './inter/inter-vietnamese.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  variable: '--font-inter',
  declarations: [
    { prop: 'font-family', value: 'Inter' },
    {
      prop: 'unicode-range',
      value:
        'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB',
    },
  ],
});

const interLatinExt = localFont({
  src: './inter/inter-latin-ext.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  variable: '--font-inter',
  declarations: [
    { prop: 'font-family', value: 'Inter' },
    {
      prop: 'unicode-range',
      value:
        'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF',
    },
  ],
});

const interLatin = localFont({
  src: './inter/inter-latin.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  preload: true,
  adjustFontFallback: false,
  variable: '--font-inter',
  declarations: [
    { prop: 'font-family', value: 'Inter' },
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
});

/** Classes das dez faces, para o <html>. A ordem é a das declarações acima. */
export const fontClassNames = [
  frauncesVietnamese,
  frauncesLatinExt,
  frauncesLatin,
  interCyrillicExt,
  interCyrillic,
  interGreekExt,
  interGreek,
  interVietnamese,
  interLatinExt,
  interLatin,
]
  .map((font) => font.variable)
  .join(' ');
