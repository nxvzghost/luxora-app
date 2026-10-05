import { describe, it, expect, vi } from 'vitest';
import { WhatsAppMessageProvider } from '@infrastructure/messaging/whatsapp-message.provider';
import { MessageProviderError } from '@domain-services/communication/message-provider';
import { AnthropicAIProvider } from '@infrastructure/ai/anthropic-ai.provider';
import { AsaasPaymentProvider } from '@infrastructure/payment/asaas-payment.provider';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { ClinicRepository } from '@domain-services/platform/clinic.repository';
import { TherapistRepository } from '@domain-services/platform/therapist.repository';
import { MetricsService } from '@shared/metrics.service';
import { TokenCipherService } from '@shared/token-cipher.service';
import { loadBackendEnv, logSmoke } from './support/smoke-env';

/**
 * [MANUAL / EXTERNAL] Chamadas reais aos três providers com uma credencial
 * INVÁLIDA DE PROPÓSITO. Não usa nem exige credencial real, não custa nada
 * e não produz efeito: cada serviço recusa a chamada na autenticação.
 *
 * Só roda com EXTERNAL_SMOKE=1 (toca a rede). Ver test/manual/README.md.
 *
 * O que isto prova contra a API real: o endereço responde a partir deste
 * ambiente, o corpo de erro verdadeiro é lido pelo nosso código, a falha é
 * classificada como permanente (sem nova tentativa) e nada da credencial
 * aparece na mensagem de erro. O que isto NÃO prova: o caminho feliz —
 * esse continua dependendo de credencial de teste (ver os outros arquivos
 * desta pasta).
 *
 * Asaas: o endereço é fixado no sandbox dentro do teste, qualquer que seja
 * o valor do .env — nunca toca a produção.
 */
loadBackendEnv();

const enabled = process.env.EXTERNAL_SMOKE === '1';

const INVALID_CREDENTIAL = 'credencial-invalida-de-proposito';
const TENANT_ID = '00000000-0000-4000-8000-000000000003';
const ASAAS_SANDBOX_URL = 'https://api-sandbox.asaas.com/v3';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function buildWhatsAppProvider(): WhatsAppMessageProvider {
  process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY ||= 'chave-descartavel-so-para-este-teste-0123456789';
  const tokenCipher = new TokenCipherService();
  const prismaClient = {
    whatsAppIntegration: {
      findUnique: async () => ({
        tenantId: TENANT_ID,
        phoneNumberId: '100000000000000',
        accessToken: tokenCipher.encrypt(INVALID_CREDENTIAL),
        active: true,
      }),
    },
  } as unknown as PrismaClientProvider;
  return new WhatsAppMessageProvider(prismaClient, tokenCipher);
}

describe.skipIf(!enabled)('[MANUAL / EXTERNAL] Rejeição de credencial inválida — nenhuma credencial real é usada', () => {
  it('Meta: a Graph API recusa o token inválido; o provider lê o erro real e classifica como falha permanente', async () => {
    const provider = buildWhatsAppProvider();

    const start = Date.now();
    const error = await provider
      .send({
        tenantId: TENANT_ID,
        toPhoneNumber: '5500000000000',
        body: '[TESTE LUXORA] rejeição esperada — nunca é entregue',
        idempotencyKey: `smoke-rejeicao-meta-${Date.now()}`,
        correlationId: 'smoke-rejeicao-meta',
      })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(error).toBeInstanceOf(MessageProviderError);
    const failure = error as MessageProviderError;
    logSmoke('meta', {
      chamada: 'POST /{phone-number-id}/messages (token inválido)',
      http: failure.status,
      classificacao: failure.retryable ? 'REPETIVEL' : 'PERMANENTE',
      detalhe: failure.message.split('): ')[1]?.replace(/\s/g, ''),
      latencia_ms: Date.now() - start,
    });

    expect(failure.retryable).toBe(false);
    expect([400, 401]).toContain(failure.status);
    // Campos extraídos de um corpo de erro verdadeiro da Meta.
    expect(failure.message).toMatch(/code=\d+/);
    expect(failure.message).toMatch(/fbtrace_id=(?!ausente)\S+/);
    expect(failure.message).not.toContain(INVALID_CREDENTIAL);
  }, 30000);

  it('Meta: versão da Graph API pedida pelo provider × versão que a Meta está servindo', async () => {
    const apiUrl = (buildWhatsAppProvider() as unknown as { apiUrl: string }).apiUrl;
    const requested = apiUrl.split('/').pop();

    const response = await fetch(`${apiUrl}/`, { signal: AbortSignal.timeout(15000) });
    const served = response.headers.get('facebook-api-version');

    // Versão expirada não dá erro: a Meta atende com a mais antiga ainda
    // disponível. Por isso é só um registro — o que importa é a linha abaixo.
    logSmoke('meta', {
      chamada: 'GET /{versão}/ (sem credencial)',
      versao_pedida: requested,
      versao_servida: served ?? undefined,
      situacao: served === requested ? 'vigente' : 'ATENCAO_versao_pedida_expirada',
    });

    expect(served).toMatch(/^v\d+\.\d+$/);
  }, 30000);

  it('Anthropic: chave inválida → 401, uma única chamada (sem nova tentativa) e sem a chave na mensagem de erro', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = INVALID_CREDENTIAL;
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.fn((...args: Parameters<typeof fetch>) => realFetch(...args));
    vi.stubGlobal('fetch', fetchSpy);

    try {
      const provider = new AnthropicAIProvider(
        { findByTenantId: async () => ({ name: 'Clínica Exemplo (teste de integração)' }) } as unknown as ClinicRepository,
        { findAllByTenant: async () => [] } as unknown as TherapistRepository,
        new MetricsService(),
      );

      const start = Date.now();
      const error = await provider
        .interpretIntent({
          tenantId: TENANT_ID,
          conversationHistory: [],
          message: 'Mensagem sintética de teste de integração.',
          correlationId: 'smoke-rejeicao-anthropic',
        })
        .then(
          () => null,
          (err: unknown) => err,
        );

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      logSmoke('anthropic', {
        chamada: 'POST /v1/messages (chave inválida)',
        http: message.match(/\((\d{3})\)/)?.[1],
        tipo_erro: message.match(/"type":\s*"(\w+_error)"/)?.[1],
        request_id: message.match(/"request_id":\s*"([^"]+)"/)?.[1],
        chamadas_feitas: fetchSpy.mock.calls.length,
        classificacao: 'PERMANENTE',
        latencia_ms: Date.now() - start,
      });

      expect(message).toContain('(401)');
      expect(message).not.toContain(INVALID_CREDENTIAL);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      restoreEnv('ANTHROPIC_API_KEY', originalKey);
    }
  }, 30000);

  it('Asaas SANDBOX: chave inválida → 401, sem a chave na mensagem de erro', async () => {
    const original = {
      key: process.env.ASAAS_API_KEY,
      url: process.env.ASAAS_BASE_URL,
      env: process.env.ASAAS_ENV,
    };
    process.env.ASAAS_BASE_URL = ASAAS_SANDBOX_URL;
    process.env.ASAAS_ENV = 'sandbox';
    process.env.ASAAS_API_KEY = INVALID_CREDENTIAL;

    try {
      const start = Date.now();
      const error = await new AsaasPaymentProvider().cancelSubscription('sub_inexistente_teste_luxora').then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      logSmoke('asaas-sandbox', {
        chamada: 'DELETE /subscriptions/{id} (chave inválida)',
        http: message.match(/\((\d{3})\)/)?.[1],
        codigo: message.match(/"code":\s*"([^"]+)"/)?.[1],
        latencia_ms: Date.now() - start,
      });

      expect(message).toContain('(401)');
      expect(message).not.toContain(INVALID_CREDENTIAL);
    } finally {
      restoreEnv('ASAAS_API_KEY', original.key);
      restoreEnv('ASAAS_BASE_URL', original.url);
      restoreEnv('ASAAS_ENV', original.env);
    }
  }, 30000);
});
