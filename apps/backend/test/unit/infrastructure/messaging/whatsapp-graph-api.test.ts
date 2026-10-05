import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  WHATSAPP_GRAPH_API_URL,
  WHATSAPP_GRAPH_API_VERSION,
  WHATSAPP_GRAPH_API_VERSION_EXPIRES_ON,
} from '@infrastructure/messaging/whatsapp-graph-api';
import { WhatsAppMessageProvider } from '@infrastructure/messaging/whatsapp-message.provider';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { TokenCipherService } from '@shared/token-cipher.service';

/**
 * Fase 3B da auditoria — a versão da Graph API tem um único ponto de
 * definição e não pode voltar a ser uma versão expirada.
 *
 * O terceiro teste depende da data de hoje, de propósito: quando a versão
 * fixada expirar, ele falha e aponta o que atualizar. Versão expirada não dá
 * erro na Meta — sem este teste, ninguém ficaria sabendo.
 */

const SRC_DIR = path.resolve(__dirname, '../../../../src');
const CENTRAL_FILE = path.join('infrastructure', 'messaging', 'whatsapp-graph-api.ts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(fullPath);
    }
    return entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Graph API da Meta — versão única e vigente (Fase 3B)', () => {
  it('a versão tem o formato vN.N e a URL é derivada dela', () => {
    expect(WHATSAPP_GRAPH_API_VERSION).toMatch(/^v\d+\.\d+$/);
    expect(WHATSAPP_GRAPH_API_URL).toBe(`https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}`);
  });

  it('não é uma das versões que já estavam expiradas em 05/10/2026 (v20.0 e anteriores)', () => {
    const major = Number(WHATSAPP_GRAPH_API_VERSION.slice(1).split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(21);
  });

  it('a data de expiração registrada é válida e ainda não chegou', () => {
    expect(WHATSAPP_GRAPH_API_VERSION_EXPIRES_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const lastValidInstant = new Date(`${WHATSAPP_GRAPH_API_VERSION_EXPIRES_ON}T23:59:59Z`).getTime();
    expect(Number.isNaN(lastValidInstant)).toBe(false);

    expect(
      Date.now(),
      `A versão ${WHATSAPP_GRAPH_API_VERSION} da Graph API expirou em ${WHATSAPP_GRAPH_API_VERSION_EXPIRES_ON}. ` +
        'Atualize as duas constantes de src/infrastructure/messaging/whatsapp-graph-api.ts com uma versão vigente ' +
        '(developers.facebook.com/docs/graph-api/changelog/versions) e rode o smoke externo.',
    ).toBeLessThanOrEqual(lastValidInstant);
  });

  it('nenhum outro arquivo de src/ escreve uma versão da Graph API por conta própria', () => {
    const offenders = sourceFiles(SRC_DIR)
      .filter((file) => !file.endsWith(CENTRAL_FILE))
      .filter((file) => /graph\.facebook\.com\/v\d/.test(readFileSync(file, 'utf-8')))
      .map((file) => path.relative(SRC_DIR, file));

    expect(offenders).toEqual([]);
  });

  it('o provider chama exatamente a URL central', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new WhatsAppMessageProvider(
      {
        whatsAppIntegration: {
          findUnique: vi.fn().mockResolvedValue({ tenantId: 't1', phoneNumberId: 'pnid-1', accessToken: 'cifrado', active: true }),
        },
      } as unknown as PrismaClientProvider,
      { decrypt: () => 'token' } as unknown as TokenCipherService,
    );
    await provider.send({ tenantId: 't1', toPhoneNumber: '5500000000000', body: 'Olá', idempotencyKey: 'k1' });

    expect(fetchMock.mock.calls[0][0]).toBe(`${WHATSAPP_GRAPH_API_URL}/pnid-1/messages`);
  });
});
