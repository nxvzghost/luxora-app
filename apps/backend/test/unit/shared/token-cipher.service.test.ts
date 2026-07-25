import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TokenCipherService } from '@shared/token-cipher.service';

/**
 * AD-005 — TokenCipherService é o único ponto do sistema que entende o
 * formato versionado de criptografia em repouso. Cobre: round-trip
 * (cifra → decifra igual ao original), compatibilidade retroativa com
 * valores legados (texto puro, pré-AD-005), e rejeição de dado adulterado.
 */
describe('TokenCipherService', () => {
  const ORIGINAL_KEY = process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = 'chave-de-teste-nao-usar-em-producao-2026';
  });

  afterEach(() => {
    process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = ORIGINAL_KEY;
  });

  it('lança erro na construção se WHATSAPP_TOKEN_ENCRYPTION_KEY não estiver definida', () => {
    delete process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY;
    expect(() => new TokenCipherService()).toThrow(/WHATSAPP_TOKEN_ENCRYPTION_KEY/);
  });

  it('round-trip: decrypt(encrypt(x)) === x', () => {
    const service = new TokenCipherService();
    const plaintext = 'EAAG-token-real-do-meta-business-1234567890';

    const encrypted = service.encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted.startsWith('v1:')).toBe(true);

    const decrypted = service.decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('duas chamadas a encrypt() para o mesmo texto produzem ciphertexts diferentes (IV aleatório)', () => {
    const service = new TokenCipherService();
    const a = service.encrypt('mesmo-texto');
    const b = service.encrypt('mesmo-texto');
    expect(a).not.toBe(b);
    expect(service.decrypt(a)).toBe('mesmo-texto');
    expect(service.decrypt(b)).toBe('mesmo-texto');
  });

  it('compatibilidade retroativa: decrypt() devolve um valor legado (texto puro, sem prefixo v1:) exatamente como está', () => {
    const service = new TokenCipherService();
    const legacyPlainToken = 'token-antigo-gravado-antes-da-ad-005';
    expect(service.decrypt(legacyPlainToken)).toBe(legacyPlainToken);
  });

  it('rejeita um valor no formato v1 adulterado (authTag não confere) — nunca devolve texto corrompido silenciosamente', () => {
    const service = new TokenCipherService();
    const encrypted = service.encrypt('token-original');
    const parts = encrypted.split(':');
    // Adultera o ciphertext (último segmento) mantendo o formato v1 válido.
    const tampered = [parts[0], parts[1], parts[2], Buffer.from('adulterado').toString('base64')].join(':');

    expect(() => service.decrypt(tampered)).toThrow(/Falha ao decifrar/);
  });

  it('decrypt() com uma chave diferente da usada em encrypt() falha (nunca decifra com a chave errada)', () => {
    const serviceA = new TokenCipherService();
    const encrypted = serviceA.encrypt('token-secreto');

    process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = 'outra-chave-completamente-diferente-2026';
    const serviceB = new TokenCipherService();

    expect(() => serviceB.decrypt(encrypted)).toThrow(/Falha ao decifrar/);
  });
});
