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
