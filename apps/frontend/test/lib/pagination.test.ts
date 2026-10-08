import { describe, it, expect, afterEach, vi } from 'vitest';
import { apiError, mockApi } from '../support/mock-api';
import { fetchAllPages } from '@/lib/api-client/pagination';

/**
 * Tarefa 05 da auditoria — as listas de pacientes e de cobranças são
 * paginadas pela API; as telas precisam da lista inteira.
 */

const items = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}` }));

afterEach(() => vi.unstubAllGlobals());

describe('fetchAllPages', () => {
  it('uma página incompleta basta: uma única chamada, pedindo 100 itens', async () => {
    const api = mockApi({ 'GET /patients': { body: { data: items(3, 'p') } } });

    const result = await fetchAllPages('/patients', 'token');

    expect(result.data).toHaveLength(3);
    expect(api.sent('GET', '/patients')).toHaveLength(1);
    expect(api.sent('GET', '/patients')[0].query.get('limit')).toBe('100');
    expect(api.sent('GET', '/patients')[0].query.get('cursor')).toBeNull();
  });

  it('página cheia: continua a partir do id do último item até vir uma página incompleta', async () => {
    const api = mockApi({
      'GET /patients': (request) => {
        const cursor = request.query.get('cursor');
        if (!cursor) return { body: { data: items(100, 'a') } };
        if (cursor === 'a-99') return { body: { data: items(100, 'b') } };
        return { body: { data: items(7, 'c') } };
      },
    });

    const result = await fetchAllPages<{ id: string }>('/patients', 'token');

    expect(result.data).toHaveLength(207);
    expect(result.data[206].id).toBe('c-6');
    expect(api.sent('GET', '/patients').map((request) => request.query.get('cursor'))).toEqual([null, 'a-99', 'b-99']);
  });

  it('lista com exatamente uma página cheia: a página seguinte vem vazia e a busca termina', async () => {
    const api = mockApi({
      'GET /billings': (request) => ({ body: { data: request.query.get('cursor') ? [] : items(100, 'x') } }),
    });

    const result = await fetchAllPages('/billings', 'token');

    expect(result.data).toHaveLength(100);
    expect(api.sent('GET', '/billings')).toHaveLength(2);
  });

  it('falha no meio da paginação rejeita em vez de devolver uma lista incompleta', async () => {
    mockApi({
      'GET /patients': (request) => (request.query.get('cursor') ? apiError(500, 'INTERNAL_SERVER_ERROR', 'erro') : { body: { data: items(100, 'a') } }),
    });

    await expect(fetchAllPages('/patients', 'token')).rejects.toMatchObject({ status: 500 });
  });
});
