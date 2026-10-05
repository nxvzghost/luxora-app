import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsaasPaymentProvider, redactCardData } from '@infrastructure/payment/asaas-payment.provider';

/**
 * Fase 2 da auditoria (R5) — dado de cartão nunca sai numa mensagem de erro
 * do provider. A rede é sempre substituída: nenhuma chamada real à Asaas.
 */

const PAN = '4111111111111111';
const CCV = '9173';

const cardInput = {
  asaasSubscriptionId: 'sub_teste_123',
  holderName: 'Maria Teste',
  number: PAN,
  expiryMonth: '12',
  expiryYear: '2031',
  ccv: CCV,
  holderEmail: 'maria@clinica.dev',
  holderCpfCnpj: '12345678909',
  remoteIp: '203.0.113.7',
};

function response(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

describe('redactCardData', () => {
  it('mascara número de cartão contíguo, com espaços e com traços', () => {
    expect(redactCardData(`cartão ${PAN} recusado`)).toBe('cartão [número omitido] recusado');
    expect(redactCardData('cartão 4111 1111 1111 1111 recusado')).toBe('cartão [número omitido] recusado');
    expect(redactCardData('cartão 4111-1111-1111-1111 recusado')).toBe('cartão [número omitido] recusado');
  });

  it('mascara números de 13 a 19 dígitos (bandeiras diferentes)', () => {
    expect(redactCardData('4222222222222')).toBe('[número omitido]'); // 13
    expect(redactCardData('378282246310005')).toBe('[número omitido]'); // 15
    expect(redactCardData('6011000990139424123')).toBe('[número omitido]'); // 19
  });

  it('mascara o valor de campos de código de segurança em JSON e em texto', () => {
    expect(redactCardData(`{"ccv":"${CCV}","holderName":"Maria"}`)).toBe('{"ccv":"[omitido]","holderName":"Maria"}');
    expect(redactCardData(`{"cvv": ${CCV}}`)).toBe('{"cvv": [omitido]}');
    expect(redactCardData(`cvc=${CCV} recusado`)).toBe('cvc=[omitido] recusado');
    expect(redactCardData(`{"securityCode":"${CCV}"}`)).toBe('{"securityCode":"[omitido]"}');
  });

  it('preserva o que não é dado de cartão: códigos de erro, valores, datas e ids curtos', () => {
    const text = '{"errors":[{"code":"invalid_creditCard","description":"Transação não autorizada em 2026-10-05, valor 199.90"}],"id":"sub_abc123"}';
    expect(redactCardData(text)).toBe(text);
  });
});

describe('AsaasPaymentProvider.attachCreditCard', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let provider: AsaasPaymentProvider;
  const savedEnv = { key: process.env.ASAAS_API_KEY, url: process.env.ASAAS_BASE_URL };

  beforeEach(() => {
    process.env.ASAAS_API_KEY = 'chave-falsa-de-teste-unitario';
    process.env.ASAAS_BASE_URL = 'http://asaas.invalid/v3';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    provider = new AsaasPaymentProvider();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedEnv.key === undefined) delete process.env.ASAAS_API_KEY;
    else process.env.ASAAS_API_KEY = savedEnv.key;
    if (savedEnv.url === undefined) delete process.env.ASAAS_BASE_URL;
    else process.env.ASAAS_BASE_URL = savedEnv.url;
  });

  it('envia os dados do cartão só para a Asaas, no endpoint da assinatura', async () => {
    fetchMock.mockResolvedValue(response(200, '{}'));

    await provider.attachCreditCard(cardInput);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://asaas.invalid/v3/subscriptions/sub_teste_123/creditCard');
    expect(init.method).toBe('PUT');
    const sent = JSON.parse(init.body);
    expect(sent.creditCard.number).toBe(PAN);
    expect(sent.creditCard.ccv).toBe(CCV);
  });

  it('quando a Asaas devolve erro ecoando o cartão, a mensagem da exceção não contém número nem CCV', async () => {
    const echoedBody = JSON.stringify({
      errors: [{ code: 'invalid_creditCard', description: `Cartão ${PAN} recusado` }],
      creditCard: { holderName: 'Maria Teste', number: PAN, ccv: CCV },
    });
    fetchMock.mockResolvedValue(response(400, echoedBody));

    const error = (await provider.attachCreditCard(cardInput).catch((e) => e)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Falha na chamada Asaas PUT /subscriptions/sub_teste_123/creditCard (400)');
    expect(error.message).toContain('invalid_creditCard');
    expect(error.message).not.toContain(PAN);
    expect(error.message).not.toContain(CCV);
    expect(error.stack ?? '').not.toContain(PAN);
  });

  it('trunca um corpo de erro muito longo', async () => {
    fetchMock.mockResolvedValue(response(500, 'x'.repeat(5000)));
    const error = (await provider.attachCreditCard(cardInput).catch((e) => e)) as Error;
    expect(error.message.length).toBeLessThan(700);
  });
});
