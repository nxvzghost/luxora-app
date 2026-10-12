/**
 * Dia e hora no fuso de uma clínica — AD-039 (ADR-0064).
 *
 * O sistema guarda e compara instantes (um `Date` é um ponto no tempo, igual
 * em qualquer lugar). O que depende de fuso é a pergunta "que dia e que hora
 * é este instante?" — e a resposta tem de ser a da clínica, não a da máquina
 * em que o processo roda. O contêiner roda em UTC; antes desta mudança a
 * janela "09:00" de uma clínica de São Paulo caía às 06:00 de lá.
 *
 * Funções puras, sem dependência: as regras de cada fuso (inclusive horário
 * de verão) vêm do `Intl` do próprio Node, que carrega a base de fusos da
 * IANA. Nenhuma função daqui lê o fuso do processo — os métodos locais de
 * `Date` (`getHours`, `setHours`, `getDay`, `toDateString`…) não são usados.
 */
export const DEFAULT_CLINIC_TIME_ZONE = 'America/Sao_Paulo';

/** Uma data do calendário, sem hora e sem fuso. `month` vai de 1 a 12. */
export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/** Data e hora de parede em algum fuso. `dayOfWeek`: 0 = domingo … 6 = sábado. */
export interface LocalDateTime extends CivilDate {
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number;
}

const DAY_IN_MS = 24 * 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // Lança RangeError para um fuso que não existe.
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** O nome é de um fuso que este Node conhece (ex.: `America/Sao_Paulo`)? */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Devolve o fuso, ou lança se o nome não for de um fuso conhecido — nunca troca por outro em silêncio. */
export function assertTimeZone(timeZone: unknown): string {
  if (!isValidTimeZone(timeZone)) {
    throw new Error(`Fuso horário inválido: "${String(timeZone)}". Use um nome da base IANA, como "${DEFAULT_CLINIC_TIME_ZONE}".`);
  }
  return timeZone;
}

/** Que dia e que hora é `instant` no fuso `timeZone`. */
export function localDateTime(instant: Date, timeZone: string): LocalDateTime {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const { year, month, day, hour, minute, second } = parts;
  return { year, month, day, hour, minute, second, dayOfWeek: dayOfWeekOf({ year, month, day }) };
}

/** A data do calendário em que `instant` cai no fuso `timeZone`. */
export function civilDateIn(instant: Date, timeZone: string): CivilDate {
  const { year, month, day } = localDateTime(instant, timeZone);
  return { year, month, day };
}

/** Dia da semana de uma data do calendário (0 = domingo … 6 = sábado). */
export function dayOfWeekOf(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** A data `days` dias depois (ou antes, se negativo), pelo calendário. */
export function addCivilDays(date: CivilDate, days: number): CivilDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** Número que cresce um por dia do calendário — serve para comparar datas e contar dias entre elas. */
export function civilDayNumber(date: CivilDate): number {
  return Math.round(Date.UTC(date.year, date.month - 1, date.day) / DAY_IN_MS);
}

/** `AAAA-MM-DD`. */
export function formatCivilDate(date: CivilDate): string {
  const pad = (value: number, size: number) => String(value).padStart(size, '0');
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

/** Quanto o relógio de parede do fuso está à frente do UTC naquele instante, em milissegundos. */
function offsetAt(instant: Date, timeZone: string): number {
  const local = localDateTime(instant, timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * O instante em que o relógio de parede do fuso marca aquela data e hora.
 *
 * Nos dias de mudança de horário de verão (não é o caso de
 * `America/Sao_Paulo`, que não tem desde 2019) uma hora de parede pode não
 * existir ou existir duas vezes:
 *   - hora que não existe (o relógio pulou por cima dela): vale o instante
 *     equivalente logo depois do salto — 02:30 em um dia que pula das 02:00
 *     para as 03:00 vira 03:30;
 *   - hora que existe duas vezes (o relógio voltou): vale a primeira.
 * É a mesma escolha que a proposta Temporal do JavaScript chama de
 * "compatible".
 */
export function instantAt(timeZone: string, date: CivilDate, time: { hour?: number; minute?: number; second?: number } = {}): Date {
  const { hour = 0, minute = 0, second = 0 } = time;
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute, second);
  // Os dois deslocamentos possíveis em volta daquela hora: o de um dia antes e o de um dia depois.
  const before = offsetAt(new Date(wall - DAY_IN_MS), timeZone);
  const after = offsetAt(new Date(wall + DAY_IN_MS), timeZone);
  const matches = (candidate: number) => {
    const local = localDateTime(new Date(candidate), timeZone);
    return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) === wall;
  };
  const candidates = [wall - before, wall - after].filter(matches);
  if (candidates.length > 0) return new Date(Math.min(...candidates));
  // Hora que não existe: o deslocamento de antes do salto leva para depois dele.
  return new Date(wall - before);
}

/** A meia-noite que abre, no fuso `timeZone`, o dia em que `instant` cai. */
export function startOfLocalDay(instant: Date, timeZone: string): Date {
  return instantAt(timeZone, civilDateIn(instant, timeZone));
}

/** O primeiro e o último instante (com precisão de milissegundo) daquele dia do calendário, no fuso `timeZone`. */
export function localDayRange(timeZone: string, date: CivilDate): { from: Date; to: Date } {
  const from = instantAt(timeZone, date);
  const to = new Date(instantAt(timeZone, addCivilDays(date, 1)).getTime() - 1);
  return { from, to };
}

/** Os dois instantes caem no mesmo dia do calendário, no fuso `timeZone`? */
export function isSameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  return civilDayNumber(civilDateIn(a, timeZone)) === civilDayNumber(civilDateIn(b, timeZone));
}

/**
 * A data do calendário que um vencimento representa.
 *
 * O vencimento é uma data sem hora. A API a recebe como `AAAA-MM-DD` e a
 * guarda como a meia-noite UTC daquele dia; a data que vale é, portanto, a
 * do instante lido em UTC — nunca a do fuso do processo, e nunca a do fuso
 * da clínica (que, para São Paulo, leria o dia anterior).
 */
export function civilDateOfDateOnly(value: Date): CivilDate {
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}
