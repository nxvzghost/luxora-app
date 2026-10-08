import { apiRequest } from '@/lib/api-client/client';

const PAGE_SIZE = 100;
/** Trava de segurança: 100 páginas de 100 itens. Acima disso a lista é cortada em vez de a tela buscar sem fim. */
const MAX_PAGES = 100;

/**
 * fetchAllPages — Tarefa 05 da auditoria.
 *
 * ACHADO REAL: GET /patients e GET /billings paginam por cursor e devolvem
 * 20 itens quando nada é pedido. As telas pediam só essa primeira página:
 * o 21º paciente não aparecia nos seletores da Agenda e do Financeiro, e os
 * totais do Financeiro somavam só as 20 cobranças mais recentes.
 *
 * A busca agora segue de página em página até a API devolver uma página
 * incompleta. O cursor é o id do último item recebido, como a API espera.
 */
export async function fetchAllPages<T extends { id: string }>(path: string, token: string | null): Promise<{ data: T[] }> {
  const all: T[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query: string = `limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const { data } = await apiRequest<{ data: T[] }>(`${path}?${query}`, { token });
    all.push(...data);
    if (data.length < PAGE_SIZE) break;
    cursor = data[data.length - 1].id;
  }

  return { data: all };
}
