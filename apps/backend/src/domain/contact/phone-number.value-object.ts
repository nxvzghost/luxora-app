/**
 * PhoneNumber — Value Object de identidade de canal (ADR-0055/ADR-0043).
 *
 * Responsabilidade única: normalizar qualquer formato de entrada de
 * telefone para uma representação canônica E.164, determinística e
 * comparável por igualdade simples. Escopo deliberadamente restrito a
 * números do Brasil (DDI 55) — generalização internacional é a mesma
 * categoria de generalização prematura já descartada para canais múltiplos
 * em ADR-0043 ("Alternativas descartadas").
 *
 * Nunca usado por Conversation.phoneNumber (ADR-0053, já em produção,
 * armazena o valor bruto recebido da Meta sem normalização) — tocar essa
 * entidade já implementada, sem necessidade real, contrariaria o princípio
 * de mínimo necessário já seguido nesta sessão. Este VO é usado
 * exclusivamente por Contact, o único lugar do domínio que precisa
 * comparar telefones por igualdade de identidade (ADR-0055, "Value Object:
 * telefone normalizado").
 *
 * Limite conhecido e aceito, registrado em ADR-0055 ("Riscos"): o nono
 * dígito de celulares brasileiros não é reconciliado automaticamente — um
 * número informado sem o nono dígito nunca é adivinhado, permanece como
 * está após a normalização do DDI. Preferimos normalizar de forma
 * determinística e nunca inventar um dígito a mais.
 */
export class InvalidPhoneNumberError extends Error {
  constructor(raw: string) {
    super(`Telefone inválido, não foi possível normalizar para E.164: "${raw}".`);
    this.name = 'InvalidPhoneNumberError';
  }
}

const BRAZIL_COUNTRY_CODE = '55';
// DDI(2) + DDD(2) + número (8 ou 9 dígitos) = 12 ou 13 dígitos ao todo.
const NORMALIZED_DIGITS_PATTERN = /^55\d{10,11}$/;

export class PhoneNumber {
  private constructor(private readonly e164Value: string) {}

  /** Normaliza um valor bruto (qualquer formatação humana) — uso ao receber um telefone novo. */
  static normalize(raw: string): PhoneNumber {
    const digitsOnly = raw.replace(/\D/g, '');
    const withCountryCode = digitsOnly.startsWith(BRAZIL_COUNTRY_CODE)
      ? digitsOnly
      : `${BRAZIL_COUNTRY_CODE}${digitsOnly}`;

    if (!NORMALIZED_DIGITS_PATTERN.test(withCountryCode)) {
      throw new InvalidPhoneNumberError(raw);
    }

    return new PhoneNumber(`+${withCountryCode}`);
  }

  /** Reconstitui a partir de um valor JÁ normalizado (leitura do banco) — nunca renormaliza. */
  static fromE164(value: string): PhoneNumber {
    const digitsOnly = value.replace(/^\+/, '');
    if (!NORMALIZED_DIGITS_PATTERN.test(digitsOnly)) {
      throw new InvalidPhoneNumberError(value);
    }
    return new PhoneNumber(`+${digitsOnly}`);
  }

  toE164(): string {
    return this.e164Value;
  }

  equals(other: PhoneNumber): boolean {
    return this.e164Value === other.e164Value;
  }

  toString(): string {
    return this.e164Value;
  }
}
