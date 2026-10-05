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
 * Conversation.phoneNumber (ADR-0053) e Patient.phone continuam GRAVADOS
 * como chegaram — o valor bruto da Meta e o texto digitado no cadastro.
 * Nenhum dado gravado é reescrito por este VO.
 *
 * Fase 3B da auditoria (ADR-0059): este VO passou a ser também a regra
 * única de COMPARAÇÃO de telefone fora do Contact — a busca de paciente e a
 * de conversa pelo número do remetente comparam a forma normalizada dos
 * dois lados. Antes a comparação era por igualdade exata do texto, e o
 * paciente gravado como "+55…" não era reconhecido quando a Meta enviava o
 * mesmo número só em dígitos.
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
// DDD(2) + número (8 ou 9 dígitos): com até 11 dígitos o valor não tem DDI.
const NATIONAL_MAX_DIGITS = 11;

export class PhoneNumber {
  private constructor(private readonly e164Value: string) {}

  /** Normaliza um valor bruto (qualquer formatação humana) — uso ao receber um telefone novo. */
  static normalize(raw: string): PhoneNumber {
    const digitsOnly = raw.replace(/\D/g, '');
    // Fase 3B (ADR-0059) — quem decide se o código do país já está presente:
    //   - "+" no início: o valor se declara internacional; nada é acrescentado
    //     (um "+51…" é de outro país, nunca um DDD 51 sem o 55);
    //   - sem "+": o tamanho. Com até 11 dígitos é sempre DDD + número.
    // A regra anterior decidia pelo "55" inicial e, com isso, recusava todo
    // telefone do DDD 55 (interior do RS) escrito sem o código do país.
    const declaresCountryCode = raw.trimStart().startsWith('+');
    const withCountryCode =
      !declaresCountryCode && digitsOnly.length <= NATIONAL_MAX_DIGITS
        ? `${BRAZIL_COUNTRY_CODE}${digitsOnly}`
        : digitsOnly;

    if (!NORMALIZED_DIGITS_PATTERN.test(withCountryCode)) {
      throw new InvalidPhoneNumberError(raw);
    }

    return new PhoneNumber(`+${withCountryCode}`);
  }

  /**
   * Como normalize(), mas devolve `null` em vez de lançar. Para quem compara
   * telefones e não pode falhar por causa de um valor fora do padrão (número
   * de outro país, texto livre de um cadastro antigo).
   */
  static tryNormalize(raw: unknown): PhoneNumber | null {
    if (typeof raw !== 'string') {
      return null;
    }
    try {
      return PhoneNumber.normalize(raw);
    } catch {
      return null;
    }
  }

  /**
   * Para um número que SEMPRE vem com o código do país — o remetente que a
   * Meta entrega no webhook. Não aplica a leitura "DDD + número": um valor
   * que não comece por 55 é de outro país e devolve `null`. Sem isto, um
   * celular do Peru ("51 9XXXXXXXX") seria lido como um celular de Porto
   * Alegre escrito sem o 55.
   */
  static tryFromInternational(raw: unknown): PhoneNumber | null {
    if (typeof raw !== 'string') {
      return null;
    }
    const digitsOnly = raw.replace(/\D/g, '');
    return NORMALIZED_DIGITS_PATTERN.test(digitsOnly) ? new PhoneNumber(`+${digitsOnly}`) : null;
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

  /** Só dígitos, com o código do país e sem "+" — o formato em que a Meta entrega o remetente. */
  toDigits(): string {
    return this.e164Value.slice(1);
  }

  /** Só dígitos, sem o código do país: DDD + número. */
  toNationalDigits(): string {
    return this.e164Value.slice(1 + BRAZIL_COUNTRY_CODE.length);
  }

  equals(other: PhoneNumber): boolean {
    return this.e164Value === other.e164Value;
  }

  toString(): string {
    return this.e164Value;
  }
}
