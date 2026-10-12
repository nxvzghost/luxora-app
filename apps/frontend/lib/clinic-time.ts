/**
 * Dia e hora no fuso da clínica — AD-039 (ADR-0064), lado do painel.
 *
 * A API entrega e recebe instantes (ISO em UTC). O que depende de fuso é a
 * conversa com a pessoa: que dia e que hora mostrar, e a que instante
 * corresponde o "dia 14, 09:00" que ela escolheu. A resposta é a da CLÍNICA,
 * não a do computador de quem usa o painel — as janelas de atendimento e os
 * vencimentos valem no fuso da clínica, e quem acessa de outro fuso tem de
 * ver a mesma agenda que a recepção vê.
 *
 * Mesmas regras de `apps/backend/src/domain/shared/time-zone.ts`, com o
 * `Intl` do navegador. Nenhuma função daqui usa os métodos locais de `Date`
 * (`getHours`, `setHours`, `getDate`…).
 *
 * `timeZone` indefinido significa "o fuso deste computador": é o que o painel
 * usa enquanto ainda não leu o fuso da clínica (ver `useClinicTimeZone`).
 */
export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? '';
  let formatter = wallClockFormatters.get(key);
  if (!formatter) {
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
    wallClockFormatters.set(key, formatter);
  }
  return formatter;
}

/** Este navegador conhece o fuso? Um nome que ele não conhece faria toda formatação lançar. */
export function isKnownTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || timeZone === '') return false;
  try {
    wallClockFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** O fuso deste computador, como o navegador o informa. */
export function browserTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** O relógio de parede do fuso naquele instante, lido como se fosse UTC (em milissegundos). */
function wallClockAsUtc(instant: Date, timeZone: string | undefined): number {
  const parts: Record<string, number> = {};
  for (const part of wallClockFormatter(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/** A data do calendário em que `instant` cai no fuso. */
export function civilDateIn(instant: Date, timeZone?: string): CivilDate {
  const wall = new Date(wallClockAsUtc(instant, timeZone));
  return { year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate() };
}

/** A data `days` dias depois (ou antes, se negativo), pelo calendário. */
export function addDays(date: CivilDate, days: number): CivilDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** `AAAA-MM-DD`, o formato de um `<input type="date">`. */
export function formatDay(date: CivilDate): string {
  const pad = (value: number, size: number) => String(value).padStart(size, '0');
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

/** Lê `AAAA-MM-DD`. Devolve null para o que não é uma data do calendário (inclusive 31 de fevereiro). */
export function parseDay(day: string): CivilDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return formatDay(addDays(date, 0)) === day ? date : null;
}

/**
 * O instante em que o relógio de parede do fuso marca aquela data e hora.
 *
 * Nos dias de mudança de horário de verão, a hora que não existe vale o
 * instante equivalente depois do salto, e a que existe duas vezes vale a
 * primeira — a mesma escolha do backend.
 */
export function instantAt(timeZone: string | undefined, date: CivilDate, time: { hour?: number; minute?: number; second?: number } = {}): Date {
  const { hour = 0, minute = 0, second = 0 } = time;
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute, second);
  const offsetAt = (instant: number) => wallClockAsUtc(new Date(instant), timeZone) - Math.floor(instant / 1000) * 1000;
  // Os dois deslocamentos possíveis em volta daquela hora: o de um dia antes e o de um dia depois.
  const before = offsetAt(wall - DAY_MS);
  const after = offsetAt(wall + DAY_MS);
  const candidates = [wall - before, wall - after].filter((candidate) => wallClockAsUtc(new Date(candidate), timeZone) === wall);
  if (candidates.length > 0) return new Date(Math.min(...candidates));
  // Hora que não existe: o deslocamento de antes do salto leva para depois dele.
  return new Date(wall - before);
}

/** Hoje, no calendário do fuso, como valor de `<input type="date">`. */
export function todayInputValue(now: Date = new Date(), timeZone?: string): string {
  return formatDay(civilDateIn(now, timeZone));
}

/** A meia-noite que abre, no fuso, o dia que fica `offsetDays` dias depois de hoje. */
export function startOfDayIn(timeZone: string | undefined, offsetDays = 0, now: Date = new Date()): Date {
  return instantAt(timeZone, addDays(civilDateIn(now, timeZone), offsetDays));
}

/** Início e fim (exclusivo) de um dia do calendário do fuso, a partir do valor de um `<input type="date">`. */
export function dayRange(day: string, timeZone?: string): { from: Date; to: Date } | null {
  const date = parseDay(day);
  if (!date) return null;
  return { from: instantAt(timeZone, date), to: instantAt(timeZone, addDays(date, 1)) };
}

/**
 * O instante que corresponde ao valor de um `<input type="datetime-local">`
 * (`AAAA-MM-DDTHH:MM`), lido como hora de parede do fuso. Devolve null para
 * um valor vazio ou malformado.
 */
export function instantFromLocalInput(value: string, timeZone?: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!match) return null;
  const date = parseDay(match[1]);
  const [hour, minute, second] = [Number(match[2]), Number(match[3]), Number(match[4] ?? 0)];
  if (!date || hour > 23 || minute > 59 || second > 59) return null;
  return instantAt(timeZone, date, { hour, minute, second });
}

/** Formata um instante em pt-BR, na hora do fuso. */
export function formatInZone(instant: string | Date, options: Intl.DateTimeFormatOptions, timeZone?: string): string {
  return new Date(instant).toLocaleString('pt-BR', { ...options, timeZone });
}

/**
 * Os fusos do Brasil, na ordem em que a tela de Configurações os oferece.
 * Os nomes são os da base IANA; o rótulo é a cidade de referência de cada um.
 */
export const BRAZIL_TIME_ZONES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'America/Sao_Paulo', label: 'Brasília (São Paulo)' },
  { value: 'America/Bahia', label: 'Salvador' },
  { value: 'America/Fortaleza', label: 'Fortaleza' },
  { value: 'America/Recife', label: 'Recife' },
  { value: 'America/Maceio', label: 'Maceió' },
  { value: 'America/Belem', label: 'Belém' },
  { value: 'America/Araguaina', label: 'Araguaína (Palmas)' },
  { value: 'America/Santarem', label: 'Santarém' },
  { value: 'America/Cuiaba', label: 'Cuiabá' },
  { value: 'America/Campo_Grande', label: 'Campo Grande' },
  { value: 'America/Manaus', label: 'Manaus' },
  { value: 'America/Porto_Velho', label: 'Porto Velho' },
  { value: 'America/Boa_Vista', label: 'Boa Vista' },
  { value: 'America/Rio_Branco', label: 'Rio Branco' },
  { value: 'America/Eirunepe', label: 'Eirunepé' },
  { value: 'America/Noronha', label: 'Fernando de Noronha' },
];

/** Os demais fusos que o navegador conhece, fora os do Brasil. Lista vazia em navegador sem `Intl.supportedValuesOf`. */
export function otherTimeZones(): string[] {
  const brazil = new Set(BRAZIL_TIME_ZONES.map((zone) => zone.value));
  try {
    return Intl.supportedValuesOf('timeZone').filter((zone) => !brazil.has(zone));
  } catch {
    return [];
  }
}
