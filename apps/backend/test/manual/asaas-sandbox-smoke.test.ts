import { describe, it, expect, afterAll } from 'vitest';
import { AsaasPaymentProvider } from '@infrastructure/payment/asaas-payment.provider';
import { loadBackendEnv, logSmoke } from './support/smoke-env';

/**
 * [MANUAL] Asaas — SANDBOX. Nenhum dinheiro real: cria um cliente e uma
 * assinatura via PIX no ambiente de testes da Asaas e cancela a
 * assinatura ao final.
 *
 * Trava de ambiente: só roda com ASAAS_ENV=sandbox E ASAAS_BASE_URL
 * apontando para um host de sandbox da Asaas. Com a URL de produção o
 * arquivo inteiro é pulado, mesmo que a chave esteja definida — a chave de
 * produção nunca é enviada por este teste. Ver test/manual/README.md.
 *
 * Cartão: fora deste teste, de propósito (ver "Cartão" no README).
 */
loadBackendEnv();

const SANDBOX_HOSTS = ['api-sandbox.asaas.com', 'sandbox.asaas.com'];

function isSandboxUrl(value: string | undefined): boolean {
  try {
    return SANDBOX_HOSTS.includes(new URL(value ?? '').host);
  } catch {
    return false;
  }
}

/** CPF sintático (dígitos verificadores corretos) — só para o sandbox aceitar o cadastro. */
function syntheticCpf(): string {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const digit = (numbers: number[]) => {
    const sum = numbers.reduce((total, n, index) => total + n * (numbers.length + 1 - index), 0);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  const first = digit(base);
  const second = digit([...base, first]);
  return [...base, first, second].join('');
}

const enabled =
  Boolean(process.env.ASAAS_API_KEY) && process.env.ASAAS_ENV === 'sandbox' && isSandboxUrl(process.env.ASAAS_BASE_URL);

describe.skipIf(!enabled)('[MANUAL] Asaas sandbox — createCustomer, createSubscription, cancelSubscription', () => {
  const provider = new AsaasPaymentProvider();
  let asaasCustomerId: string;
  let asaasSubscriptionId: string | undefined;

  it('cria um cliente no sandbox', async () => {
    const start = Date.now();
    const result = await provider.createCustomer({
      name: '[TESTE SANDBOX LUXORA] Clínica Fictícia',
      email: `teste-sandbox-luxora+${Date.now()}@example.com`,
      cpfCnpj: process.env.ASAAS_SANDBOX_CPF_CNPJ || syntheticCpf(),
    });
    asaasCustomerId = result.asaasCustomerId;

    logSmoke('asaas-sandbox', { chamada: 'POST /customers', cliente: asaasCustomerId, latencia_ms: Date.now() - start });
    expect(asaasCustomerId).toMatch(/^cus_/);
  }, 30000);

  it('cria uma assinatura via PIX (sem cartão) no sandbox', async () => {
    const start = Date.now();
    const result = await provider.createSubscription({
      asaasCustomerId,
      billingType: 'PIX',
      value: 597,
      cycle: 'MONTHLY',
      description: '[TESTE SANDBOX LUXORA] Assinatura de validação',
      nextDueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    });
    asaasSubscriptionId = result.asaasSubscriptionId;

    logSmoke('asaas-sandbox', { chamada: 'POST /subscriptions', assinatura: asaasSubscriptionId, latencia_ms: Date.now() - start });
    expect(asaasSubscriptionId).toMatch(/^sub_/);
  }, 30000);

  it('credencial inválida é recusada com erro que não expõe a chave', async () => {
    const realKey = process.env.ASAAS_API_KEY as string;
    process.env.ASAAS_API_KEY = 'chave-invalida-de-proposito';
    try {
      const error = await provider.cancelSubscription('sub_inexistente').then(
        () => null,
        (err: Error) => err,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain('(401)');
      expect(error?.message).not.toContain(realKey);
    } finally {
      process.env.ASAAS_API_KEY = realKey;
    }
  }, 30000);

  afterAll(async () => {
    if (asaasSubscriptionId) {
      await provider.cancelSubscription(asaasSubscriptionId);
      logSmoke('asaas-sandbox', { chamada: 'DELETE /subscriptions/:id', assinatura: asaasSubscriptionId });
    }
  });
});
