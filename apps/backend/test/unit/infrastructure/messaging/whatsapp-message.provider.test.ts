import { describe, it, expect, afterEach, vi } from 'vitest';
import { WhatsAppMessageProvider } from '@infrastructure/messaging/whatsapp-message.provider';
import { MessageProviderError } from '@domain-services/communication/message-provider';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { TokenCipherService } from '@shared/token-cipher.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'token-em-texto-puro';
const INPUT = { tenantId: TENANT_ID, toPhoneNumber: '5500000000000', body: 'Olá', idempotencyKey: 'k1' };

function buildProvider(integration: unknown, decrypt: (value: string) => string = () => TOKEN) {
  const prismaClient = { whatsAppIntegration: { findUnique: vi.fn().mockResolvedValue(integration) } };
  const tokenCipher = { decrypt: vi.fn(decrypt) };
  return new WhatsAppMessageProvider(
    prismaClient as unknown as PrismaClientProvider,
    tokenCipher as unknown as TokenCipherService,
  );
}

const ACTIVE = { tenantId: TENANT_ID, phoneNumberId: 'pnid-1', accessToken: 'v1:cifrado', active: true };

function metaError(status: number, code: number) {
  return {
    ok: false,
    status,
    text: async () =>
      JSON.stringify({ error: { message: `texto livre com o telefone 5500000000000`, type: 'OAuthException', code, error_subcode: 33, fbtrace_id: 'trace-1' } }),
  };
}

async function failure(provider: WhatsAppMessageProvider): Promise<MessageProviderError> {
  try {
    await provider.send(INPUT);
  } catch (err) {
    return err as MessageProviderError;
  }
  throw new Error('send() deveria ter falhado.');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WhatsAppMessageProvider — classificação de falhas (Fase 3)', () => {
  it('sem integração: falha permanente, nenhuma chamada externa', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const err = await failure(buildProvider(null));

    expect(err).toBeInstanceOf(MessageProviderError);
    expect(err.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('integração inativa: falha permanente, nenhuma chamada externa', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const err = await failure(buildProvider({ ...ACTIVE, active: false }));

    expect(err.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('token que não decifra: falha permanente, sem expor o valor armazenado', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const err = await failure(
      buildProvider(ACTIVE, () => {
        throw new Error('Falha ao decifrar v1:cifrado');
      }),
    );

    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain('v1:cifrado');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
  ])('HTTP %i → retryable=%s', async (status, retryable) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(metaError(status, 190)));

    const err = await failure(buildProvider(ACTIVE));

    expect(err).toBeInstanceOf(MessageProviderError);
    expect(err.status).toBe(status);
    expect(err.retryable).toBe(retryable);
  });

  it('mensagem de erro traz só códigos e o id de rastreio — nunca token, telefone ou texto livre da Meta', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(metaError(401, 190)));

    const err = await failure(buildProvider(ACTIVE));

    expect(err.message).toContain('code=190');
    expect(err.message).toContain('subcode=33');
    expect(err.message).toContain('fbtrace_id=trace-1');
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain('5500000000000');
    expect(err.message).not.toContain('texto livre');
  });

  it('corpo de erro que não é JSON não entra na mensagem', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => '<html>segredo</html>' }));

    const err = await failure(buildProvider(ACTIVE));

    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain('segredo');
  });

  it('falha de rede: repetível, sem repassar o erro original', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`connect ECONNREFUSED com ${TOKEN}`)));

    const err = await failure(buildProvider(ACTIVE));

    expect(err.retryable).toBe(true);
    expect(err.message).toContain('falha de rede');
    expect(err.message).not.toContain(TOKEN);
  });

  it('tempo limite: repetível', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    const err = await failure(buildProvider(ACTIVE));

    expect(err.retryable).toBe(true);
    expect(err.message).toContain('tempo limite');
  });

  it('a chamada leva um AbortSignal (tempo limite ativo)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await buildProvider(ACTIVE).send(INPUT);

    expect(result.providerMessageId).toBe('wamid.1');
    const [url, options] = fetchMock.mock.calls[0] as [string, { signal: AbortSignal; headers: Record<string, string> }];
    expect(url).toContain('/pnid-1/messages');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('resposta 2xx sem id de mensagem é sucesso (nunca erro, para a fila não reenviar)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));

    const result = await buildProvider(ACTIVE).send(INPUT);

    expect(result.providerMessageId).toBe('');
  });
});
