import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // recomendado pelo NIST para GCM
const KEY_LENGTH_BYTES = 32; // AES-256
const VERSION_V1 = 'v1';
// Salt fixo, não secreto — scryptSync exige um salt, mas aqui ele só serve
// para derivar uma chave de 32 bytes a partir de um segredo de qualquer
// tamanho (mesma UX de JWT_SECRET: "string aleatória longa", não uma chave
// exata em base64). A segurança do esquema depende do segredo em
// WHATSAPP_TOKEN_ENCRYPTION_KEY, nunca deste salt.
const KEY_DERIVATION_SALT = 'luxora-whatsapp-token-cipher-v1';

/**
 * TokenCipherService — AD-005. Único ponto do sistema que sabe interpretar
 * o formato armazenado de um segredo cifrado em repouso (hoje usado só por
 * WhatsAppIntegration.accessToken). Toda a lógica de reconhecimento de
 * versão, fallback para valores legados (texto puro, pré-AD-005) e erro de
 * decifração vive exclusivamente aqui — nenhum chamador (Use Case,
 * Provider) precisa saber que o formato `v1:iv:tag:ciphertext` existe.
 *
 * Formato armazenado: `v1:<iv-base64>:<authTag-base64>:<ciphertext-base64>`.
 * O prefixo de versão existe para permitir uma rotação de chave futura
 * (v2 conviveria com v1 até uma re-gravação) sem exigir migração de schema
 * nem reescrita em massa do banco.
 */
@Injectable()
export class TokenCipherService {
  private readonly key: Buffer;

  constructor() {
    const secret = process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY;
    if (!secret) {
      throw new Error('WHATSAPP_TOKEN_ENCRYPTION_KEY não configurada — obrigatória para cifrar/decifrar credenciais de WhatsApp.');
    }
    this.key = scryptSync(secret, KEY_DERIVATION_SALT, KEY_LENGTH_BYTES);
  }

  /** Sempre produz o formato versionado atual (v1). */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [VERSION_V1, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
  }

  /**
   * Decifra um valor no formato versionado. Valores que não seguem o
   * formato reconhecido (ex.: texto puro gravado antes da AD-005) são
   * devolvidos exatamente como estão — fallback deliberado de
   * compatibilidade retroativa, não um erro. Já um valor que TEM o formato
   * `v1:...` mas falha na decifração (chave incorreta ou dado corrompido/
   * adulterado) lança erro — mascarar essa falha devolvendo o valor cru
   * romperia silenciosamente a integração com uma credencial inutilizável.
   */
  decrypt(value: string): string {
    const parts = value.split(':');
    if (parts.length !== 4 || parts[0] !== VERSION_V1) {
      return value;
    }

    const [, ivB64, authTagB64, ciphertextB64] = parts;
    try {
      const iv = Buffer.from(ivB64, 'base64');
      const authTag = Buffer.from(authTagB64, 'base64');
      const ciphertext = Buffer.from(ciphertextB64, 'base64');
      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext.toString('utf8');
    } catch (error) {
      throw new Error(
        `Falha ao decifrar valor no formato ${VERSION_V1} — chave incorreta ou dado corrompido/adulterado: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
