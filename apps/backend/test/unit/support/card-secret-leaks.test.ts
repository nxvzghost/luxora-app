import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';
import { findCcvLeaks } from '../../support/card-secret-leaks';

/**
 * R5 — o verificador de CCV usado em test/critical/card-data-exposure.test.ts.
 * Os casos "sem falso positivo" são os valores reais que derrubaram o CI
 * 39610045522 ou que podem cair no mesmo caso.
 */
const CCV = '9173';

describe('findCcvLeaks — sem falso positivo', () => {
  it.each([
    ['id de span (CI 39610045522)', "id: 'd18ef9173494a762',"],
    ['traceId', "traceId: '13e651dfc290c0cdaddc1af9173abef0',"],
    ['timestamp em microssegundos', 'timestamp: 1792590191730000,'],
    ['porta efêmera numa URL', "'url.full': 'http://127.0.0.1:49173/api/v1/subscription/credit-card',"],
    ['UUID com segmento -9173-', 'correlationId=0a4ccdcf-9173-4b2e-8c1d-5e6f7a8b9c0d'],
    ['número decimal', 'duration: 0.9173'],
    ['CCV mascarado no JSON ecoado pela Asaas', 'Falha na chamada Asaas PUT (400): {"creditCard":{"ccv":"[omitido]"}}'],
    ['CCV mascarado formatado pelo inspect', inspect({ creditCard: { ccv: '[omitido]' } })],
  ])('%s', (_label, text) => {
    expect(findCcvLeaks(text, CCV)).toEqual([]);
  });

  it('um span inteiro do exportador de console, com o id que derrubou o CI', () => {
    const span = inspect(
      {
        traceId: '46e59f24fbecd6e704c903733f833581',
        name: 'middleware - query',
        id: 'd18ef9173494a762',
        timestamp: 1792590191730000,
        attributes: { 'express.name': 'query', 'express.type': 'middleware' },
      },
      { depth: 3 },
    );
    expect(span).toContain('9173'); // o falso positivo do texto puro
    expect(findCcvLeaks(span, CCV)).toEqual([]);
  });
});

describe('findCcvLeaks — detecta o CCV como valor', () => {
  it.each([
    ['JSON', '{"ccv":"9173"}'],
    ['JSON escapado dentro de uma string', String.raw`{\"ccv\":\"9173\"}`],
    ['inspect', "ccv: '9173'"],
    ['parâmetro', 'ccv=9173&holder=Maria'],
    ['texto livre', 'CCV 9173 recusado'],
    ['valor solto entre colchetes', '[9173]'],
    ['atributo de span', "'card.ccv': '9173'"],
    ['objeto do cartão formatado pelo inspect', inspect({ creditCard: { number: '4111111111111111', ccv: '9173' } })],
  ])('%s', (_label, text) => {
    expect(findCcvLeaks(text, CCV)).not.toEqual([]);
  });

  it.each([
    ['ccv', '{"ccv":"123"}'],
    ['cvv', "cvv: '456'"],
    ['cvc', 'cvc=789'],
    ['securityCode', '{"securityCode":"0042"}'],
    ['CCV em maiúsculas', 'CCV: 321'],
  ])('chave %s com valor não mascarado, mesmo diferente do CCV do teste', (_label, text) => {
    expect(findCcvLeaks(text, CCV)).not.toEqual([]);
  });
});
