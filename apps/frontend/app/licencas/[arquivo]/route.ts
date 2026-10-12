import { FONT_LICENSE_FILES, fontLicenseFile } from '@/lib/font-licenses';

/**
 * `/licencas/fontes.txt`, `/licencas/fraunces-OFL.txt` e
 * `/licencas/inter-OFL.txt` — as licenças das fontes, servidas junto com o
 * painel (ver `lib/font-licenses.ts`).
 *
 * Geradas uma vez, no build (`force-static`), a partir dos `OFL.txt` de
 * `app/fonts`: passam a fazer parte da saída do build e, por isso, de
 * qualquer lugar onde o painel for publicado, inclusive a imagem Docker.
 * Públicas, sem login — quem recebe as fontes tem de poder ler a licença.
 * Qualquer outro nome responde 404 (`dynamicParams = false`).
 */
export const dynamic = 'force-static';
export const dynamicParams = false;

export function generateStaticParams(): Array<{ arquivo: string }> {
  return FONT_LICENSE_FILES.map((arquivo) => ({ arquivo }));
}

export async function GET(_request: Request, context: { params: Promise<{ arquivo: string }> }): Promise<Response> {
  const { arquivo } = await context.params;
  const text = fontLicenseFile(arquivo);
  if (text === null) {
    return new Response('Não encontrado.\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
