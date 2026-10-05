import { describe, it, expect } from 'vitest';
import { PhoneNumber, InvalidPhoneNumberError } from '@domain/contact/phone-number.value-object';

describe('PhoneNumber — Value Object (ADR-0055)', () => {
  it('normaliza um número sem DDI, com formatação humana, para E.164', () => {
    const phone = PhoneNumber.normalize('11 98888-7777');
    expect(phone.toE164()).toBe('+5511988887777');
  });

  it('normaliza um número já com DDI (55) e formatação humana', () => {
    const phone = PhoneNumber.normalize('+55 11 98888-7777');
    expect(phone.toE164()).toBe('+5511988887777');
  });

  it('normaliza um número já em dígitos puros, sem formatação', () => {
    const phone = PhoneNumber.normalize('5511988887777');
    expect(phone.toE164()).toBe('+5511988887777');
  });

  it('aceita telefone fixo (8 dígitos após o DDD) sem inventar o 9º dígito', () => {
    const phone = PhoneNumber.normalize('11 3333-4444');
    expect(phone.toE164()).toBe('+551133334444');
  });

  it('rejeita um valor claramente inválido (poucos dígitos)', () => {
    expect(() => PhoneNumber.normalize('123')).toThrow(InvalidPhoneNumberError);
  });

  it('rejeita string vazia', () => {
    expect(() => PhoneNumber.normalize('')).toThrow(InvalidPhoneNumberError);
  });

  it('fromE164() reconstitui um valor já normalizado sem alterá-lo', () => {
    const phone = PhoneNumber.fromE164('+5511988887777');
    expect(phone.toE164()).toBe('+5511988887777');
  });

  it('fromE164() aceita um valor sem o "+" líder e o adiciona de volta', () => {
    const phone = PhoneNumber.fromE164('5511988887777');
    expect(phone.toE164()).toBe('+5511988887777');
  });

  it('fromE164() rejeita um valor malformado', () => {
    expect(() => PhoneNumber.fromE164('+551')).toThrow(InvalidPhoneNumberError);
  });

  it('equals() compara por valor normalizado, não por identidade de objeto', () => {
    const a = PhoneNumber.normalize('(11) 98888-7777');
    const b = PhoneNumber.normalize('11988887777');
    expect(a).not.toBe(b);
    expect(a.equals(b)).toBe(true);
  });

  it('equals() retorna falso para telefones diferentes', () => {
    const a = PhoneNumber.normalize('11988887777');
    const b = PhoneNumber.normalize('11988887778');
    expect(a.equals(b)).toBe(false);
  });

  it('toString() retorna o mesmo valor de toE164()', () => {
    const phone = PhoneNumber.normalize('11988887777');
    expect(phone.toString()).toBe(phone.toE164());
  });
});

describe('PhoneNumber — regra única de normalização (Fase 3B, ADR-0059)', () => {
  it.each([
    ['com "+" e código do país', '+5541999998888'],
    ['com "+", espaços, parênteses e hífen', '+55 (41) 99999-8888'],
    ['só dígitos, com o código do país', '5541999998888'],
    ['máscara, sem o código do país', '(41) 99999-8888'],
    ['espaços, sem o código do país', '41 99999 8888'],
    ['hífens, sem o código do país', '41-99999-8888'],
    ['só dígitos, sem o código do país', '41999998888'],
    ['espaços nas pontas', '  41 99999-8888  '],
  ])('%s → mesma forma canônica', (_label, raw) => {
    expect(PhoneNumber.normalize(raw).toE164()).toBe('+5541999998888');
  });

  it.each([
    ['máscara, sem o código do país', '(55) 99999-8888', '+5555999998888'],
    ['só dígitos, sem o código do país', '55999998888', '+5555999998888'],
    ['com o código do país', '5555999998888', '+5555999998888'],
    ['fixo, sem o código do país', '55 3333-4444', '+555533334444'],
  ])('DDD 55 (interior do RS) %s: o 55 inicial não é confundido com o código do país', (_label, raw, expected) => {
    expect(PhoneNumber.normalize(raw).toE164()).toBe(expected);
  });

  it('um valor com "+" já declara o código do país — "+51…" é de outro país, não DDD 51 sem o 55', () => {
    expect(() => PhoneNumber.normalize('+51 987 654 321')).toThrow(InvalidPhoneNumberError);
    expect(PhoneNumber.normalize('51 98765-4321').toE164()).toBe('+5551987654321');
  });

  it.each([
    ['outro país, com "+"', '+351 912 345 678'],
    ['outro país, só dígitos (12)', '351912345678'],
    ['zero à frente do DDD', '041 99999-8888'],
    ['sem DDD', '99999-8888'],
    ['vazio', ''],
  ])('tryNormalize() devolve null em vez de lançar — %s', (_label, raw) => {
    expect(PhoneNumber.tryNormalize(raw)).toBeNull();
  });

  it('tryNormalize() devolve null para o que não é texto', () => {
    expect(PhoneNumber.tryNormalize(undefined)).toBeNull();
    expect(PhoneNumber.tryNormalize(null)).toBeNull();
    expect(PhoneNumber.tryNormalize(5541999998888)).toBeNull();
  });

  it('tryNormalize() devolve o mesmo que normalize() para um valor válido', () => {
    expect(PhoneNumber.tryNormalize('(41) 99999-8888')?.toE164()).toBe('+5541999998888');
  });

  it('toDigits() e toNationalDigits() — as duas formas usadas para comparar com um valor gravado', () => {
    const phone = PhoneNumber.normalize('(41) 99999-8888');
    expect(phone.toDigits()).toBe('5541999998888');
    expect(phone.toNationalDigits()).toBe('41999998888');
  });

  describe('tryFromInternational() — número que sempre vem com o código do país (remetente da Meta)', () => {
    it.each([
      ['celular', '5541999998888', '+5541999998888'],
      ['celular antigo, sem o nono dígito', '554199998888', '+554199998888'],
      ['com "+"', '+5541999998888', '+5541999998888'],
      ['DDD 55', '5555999998888', '+5555999998888'],
    ])('aceita %s', (_label, raw, expected) => {
      expect(PhoneNumber.tryFromInternational(raw)?.toE164()).toBe(expected);
    });

    it.each([
      ['Peru — os mesmos dígitos de um celular de Porto Alegre sem o 55', '51987654321'],
      ['Estados Unidos', '14155552671'],
      ['Portugal', '351912345678'],
      ['DDD + número, sem o código do país', '41999998888'],
      ['vazio', ''],
    ])('recusa %s', (_label, raw) => {
      expect(PhoneNumber.tryFromInternational(raw)).toBeNull();
    });

    it('recusa o que não é texto', () => {
      expect(PhoneNumber.tryFromInternational(undefined)).toBeNull();
    });
  });
});
