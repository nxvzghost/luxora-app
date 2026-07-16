import { describe, it, expect, afterAll } from 'vitest';
import { AsaasPaymentProvider } from '@infrastructure/payment/asaas-payment.provider';

/**
 * [MANUAL] Integração real com a Asaas — PRODUÇÃO, dinheiro real.
 * Ver test/manual/README.md antes de rodar isto.
 *
 * NUNCA roda em CI, NUNCA roda via `pnpm test`/`pnpm dev` — só via
 * `pnpm --filter @luxora/backend test:manual`, executado manualmente por
 * um humano que decidiu validar o ambiente de produção.
 *
 * describe.skipIf: sem ASAAS_API_KEY + ASAAS_ENV=production +
 * ASAAS_TEST_CPF_CNPJ configurados, este arquivo inteiro é pulado — nunca
 * falha por credencial ausente, porque ele não deveria rodar em nenhum
 * ambiente a não ser deliberadamente, com a chave real de produção
 * presente. ASAAS_TEST_CPF_CNPJ precisa ser um CPF/CNPJ real (seu ou da
 * clínica) — nunca um valor inventado, a Asaas valida e isto cria um
 * cliente real associado a esse documento.
 */
const hasRealCredentials =
  Boolean(process.env.ASAAS_API_KEY) &&
  process.env.ASAAS_ENV === 'production' &&
  Boolean(process.env.ASAAS_TEST_CPF_CNPJ);

describe.skipIf(!hasRealCredentials)(
  '[MANUAL] Asaas produção — createCustomer, createSubscription, cancelSubscription',
  () => {
    const provider = new AsaasPaymentProvider();
    let asaasCustomerId: string;
    let asaasSubscriptionId: string | undefined;

    it('cria um cliente real na Asaas', async () => {
      const result = await provider.createCustomer({
        name: '[TESTE MANUAL LUXORA] Não excluir automaticamente',
        email: `teste-manual-luxora+${Date.now()}@example.com`,
        cpfCnpj: process.env.ASAAS_TEST_CPF_CNPJ as string,
      });
      expect(result.asaasCustomerId).toBeTruthy();
      asaasCustomerId = result.asaasCustomerId;
    });

    it('cria uma assinatura mínima via PIX (sem cobrar cartão)', async () => {
      const result = await provider.createSubscription({
        asaasCustomerId,
        billingType: 'PIX',
        value: 597,
        cycle: 'MONTHLY',
        description: '[TESTE MANUAL LUXORA] Assinatura de validação — cancelada automaticamente ao final do teste',
        nextDueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      });
      expect(result.asaasSubscriptionId).toBeTruthy();
      asaasSubscriptionId = result.asaasSubscriptionId;
    });

    afterAll(async () => {
      // Cleanup best-effort: cancela a assinatura de teste para não deixar
      // cobrança recorrente real ativa. Não apaga o cliente — isso fica a
      // cargo de quem rodou o teste, direto no painel da Asaas.
      if (asaasSubscriptionId) {
        await provider.cancelSubscription(asaasSubscriptionId);
      }
    });
  },
);

if (Boolean(process.env.ASAAS_API_KEY) && process.env.ASAAS_ENV === 'production' && !process.env.ASAAS_TEST_CPF_CNPJ) {
  describe('[MANUAL] Asaas produção — configuração incompleta', () => {
    it('ASAAS_TEST_CPF_CNPJ ausente — ver test/manual/README.md', () => {
      throw new Error(
        'ASAAS_API_KEY + ASAAS_ENV=production configurados, mas ASAAS_TEST_CPF_CNPJ ausente — ' +
          'defina um CPF/CNPJ real (seu ou da clínica) no .env para rodar este teste. Nunca invente um valor.',
      );
    });
  });
}
