import { DomainEvent } from '../shared/domain-event';
import { ScheduleSlot } from './schedule-slot.value-object';

/**
 * AvailabilityCalendar — Aggregate Root do Bounded Context `Availability`
 * (ADR-0040, derivado de PD-001). Motor de Disponibilidade: nenhum módulo
 * decide se um horário está livre por conta própria, todos consultam este
 * Aggregate (via VerificarDisponibilidadeUseCase / ConsultarDisponibilidadeUseCase).
 *
 * `Therapist` nunca possui isso diretamente — 1 AvailabilityCalendar por
 * Terapeuta, referenciado por `therapistId`, nunca o contrário.
 */
export class AvailabilityCalendarUpdatedEvent extends DomainEvent {
  declare readonly action: string;

  constructor(entityId: string, tenantId: string, action: string) {
    super('CalendarioDisponibilidadeAtualizado', entityId, tenantId, { action });
  }
}

export interface AvailabilityWindow {
  dayOfWeek: number; // 0 = domingo … 6 = sábado
  startTime: string; // "HH:mm"
  endTime: string; // "HH:mm"
  /**
   * Duração real da sessão nesta janela — decisão de produto: não é mais um
   * valor único por Clínica (`Clinic.defaultSessionDurationMinutes` passa a
   * ser só a sugestão de preenchimento inicial). Cada Terapeuta define a
   * própria duração, podendo variar por janela/dia.
   */
  sessionDurationMinutes: number;
}

/**
 * AvailabilityException — bloqueio pontual do Terapeuta (férias, licença,
 * bloqueio manual etc.), PD-001 Fase 2 (B1).
 *
 * `reason` é metadado puro — nunca participa de nenhuma decisão do Motor.
 * A regra de domínio depende exclusivamente do intervalo `from`-`to`: uma
 * exceção sempre tem precedência absoluta sobre `AvailabilityWindow`,
 * qualquer que seja o motivo declarado (ou nenhum motivo declarado).
 */
export interface AvailabilityException {
  from: Date;
  to: Date;
  reason?: string;
}

export interface AvailabilityCalendarProps {
  id: string;
  tenantId: string;
  therapistId: string; // referência, nunca posse — ADR-0040
  windows: AvailabilityWindow[];
  /**
   * Opcional nesta etapa (PD-001 Fase 2, B1) — persistência de exceções
   * ainda não existe (fica para uma tarefa própria de infraestrutura), então
   * `reconstitute()` a partir de um dado hoje sem exceções (ex:
   * PrismaAvailabilityRepository) continua compilando sem precisar inventar
   * valor nenhum. Sempre tratado como `[]` internamente quando ausente.
   */
  exceptions?: AvailabilityException[];
}

export const DEFAULT_SESSION_DURATION_MINUTES = 60;

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class AvailabilityCalendar {
  private _pendingEvents: DomainEvent[] = [];

  private constructor(private readonly props: AvailabilityCalendarProps) {}

  static create(props: Omit<AvailabilityCalendarProps, 'windows' | 'exceptions'>): AvailabilityCalendar {
    return new AvailabilityCalendar({ ...props, windows: [], exceptions: [] });
  }

  static reconstitute(props: AvailabilityCalendarProps): AvailabilityCalendar {
    return new AvailabilityCalendar(props);
  }

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get therapistId(): string {
    return this.props.therapistId;
  }

  get windows(): readonly AvailabilityWindow[] {
    return this.props.windows;
  }

  get exceptions(): readonly AvailabilityException[] {
    return this.props.exceptions ?? [];
  }

  /**
   * Substitui as janelas inteiras (não faz merge parcial) — mesma decisão
   * já validada em `Therapist.setAvailability` antes desta migração.
   */
  setWindows(windows: AvailabilityWindow[]): void {
    for (const window of windows) {
      if (window.dayOfWeek < 0 || window.dayOfWeek > 6) {
        throw new Error(`dayOfWeek inválido: ${window.dayOfWeek} (esperado 0-6).`);
      }
      if (!TIME_REGEX.test(window.startTime) || !TIME_REGEX.test(window.endTime)) {
        throw new Error(`Horário inválido em disponibilidade: ${window.startTime}-${window.endTime}.`);
      }
      if (window.startTime >= window.endTime) {
        throw new Error(`Horário de início deve ser anterior ao fim: ${window.startTime}-${window.endTime}.`);
      }
      if (window.sessionDurationMinutes <= 0) {
        throw new Error(`sessionDurationMinutes deve ser positivo: ${window.sessionDurationMinutes}.`);
      }
      const windowMinutes = this.minutesBetween(window.startTime, window.endTime);
      if (window.sessionDurationMinutes > windowMinutes) {
        throw new Error(
          `sessionDurationMinutes (${window.sessionDurationMinutes}) não pode ser maior que a janela (${windowMinutes} min).`,
        );
      }
    }
    for (let i = 0; i < windows.length; i++) {
      for (let j = i + 1; j < windows.length; j++) {
        if (windows[i].dayOfWeek !== windows[j].dayOfWeek) continue;
        const overlap = windows[i].startTime < windows[j].endTime && windows[j].startTime < windows[i].endTime;
        if (overlap) {
          throw new Error(
            `Disponibilidade sobreposta no mesmo dia: ${windows[i].startTime}-${windows[i].endTime} e ${windows[j].startTime}-${windows[j].endTime}.`,
          );
        }
      }
    }
    this.props.windows = windows;
    this._pendingEvents.push(new AvailabilityCalendarUpdatedEvent(this.props.id, this.props.tenantId, 'janelas_alteradas'));
  }

  /**
   * Substitui as exceções inteiras (mesma decisão de "não faz merge parcial"
   * já usada em `setWindows`). Único requisito de validação: `from` anterior
   * a `to` — nenhuma outra regra depende do `reason` declarado (ou da
   * ausência dele), por decisão explícita desta tarefa (PD-001 Fase 2, B1).
   */
  setExceptions(exceptions: AvailabilityException[]): void {
    for (const exception of exceptions) {
      if (exception.from >= exception.to) {
        throw new Error(
          `Início da exceção deve ser anterior ao fim: ${exception.from.toISOString()}-${exception.to.toISOString()}.`,
        );
      }
    }
    this.props.exceptions = exceptions;
    this._pendingEvents.push(new AvailabilityCalendarUpdatedEvent(this.props.id, this.props.tenantId, 'excecoes_alteradas'));
  }

  /**
   * Único método de decisão real do Motor de Disponibilidade (ADR-0040):
   * responde "esse horário está livre?". Combina a janela semanal recorrente
   * com os horários já ocupados — quem consulta Appointments é o Caso de Uso
   * chamador (sem I/O em Domain), não esta entidade.
   *
   * INVARIANTE (PD-001 Fase 2, B1): uma `AvailabilityException` sempre tem
   * precedência absoluta sobre `AvailabilityWindow` — se o intervalo
   * consultado colide com qualquer exceção registrada, a resposta é sempre
   * `false`, mesmo que a janela semanal permitisse o horário. Verificado
   * antes de qualquer outra checagem, nunca contornável.
   */
  isAvailable(from: Date, to: Date, bookedSlots: readonly ScheduleSlot[]): boolean {
    if (this.isExcepted(from, to)) return false;
    if (!this.isWithinWindow(from, to)) return false;
    const candidate = ScheduleSlot.free(this.props.therapistId, from, to);
    return !bookedSlots.some((booked) => candidate.overlapsWith(booked));
  }

  /** Verdadeiro se `[from, to)` colide com qualquer `AvailabilityException` registrada — nunca depende de `reason`. */
  private isExcepted(from: Date, to: Date): boolean {
    return (this.props.exceptions ?? []).some((exception) => from < exception.to && exception.from < to);
  }

  isWithinWindow(from: Date, to: Date): boolean {
    if (from.toDateString() !== to.toDateString()) return false;
    const dayOfWeek = from.getDay();
    return this.props.windows.some((window) => {
      if (window.dayOfWeek !== dayOfWeek) return false;
      const { start, end } = this.windowBounds(window, from);
      return from >= start && to <= end;
    });
  }

  /** Duração configurada para a janela do dia de `date`, ou o default (60min) se o dia não tem janela própria. */
  durationMinutesFor(date: Date): number {
    const window = this.props.windows.find((w) => w.dayOfWeek === date.getDay());
    return window?.sessionDurationMinutes ?? DEFAULT_SESSION_DURATION_MINUTES;
  }

  /** Gera os slots candidatos livres entre `from` e `to`, com a duração real de cada janela. */
  generateCandidateSlots(from: Date, to: Date): ScheduleSlot[] {
    const slots: ScheduleSlot[] = [];
    const cursor = new Date(from);
    cursor.setHours(0, 0, 0, 0);

    while (cursor <= to) {
      const dayWindows = this.props.windows.filter((w) => w.dayOfWeek === cursor.getDay());
      for (const window of dayWindows) {
        const { start: windowStart, end: windowEnd } = this.windowBounds(window, cursor);
        const durationMs = window.sessionDurationMinutes * 60_000;

        let slotStart = new Date(windowStart);
        while (slotStart.getTime() + durationMs <= windowEnd.getTime()) {
          const slotEnd = new Date(slotStart.getTime() + durationMs);
          if (slotStart >= from && slotEnd <= to && !this.isExcepted(slotStart, slotEnd)) {
            slots.push(ScheduleSlot.free(this.props.therapistId, slotStart, slotEnd));
          }
          slotStart = slotEnd;
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    return slots;
  }

  private windowBounds(window: AvailabilityWindow, referenceDate: Date): { start: Date; end: Date } {
    const [startH, startM] = window.startTime.split(':').map(Number);
    const [endH, endM] = window.endTime.split(':').map(Number);
    const start = new Date(referenceDate);
    start.setHours(startH, startM, 0, 0);
    const end = new Date(referenceDate);
    end.setHours(endH, endM, 0, 0);
    return { start, end };
  }

  private minutesBetween(startTime: string, endTime: string): number {
    const [startH, startM] = startTime.split(':').map(Number);
    const [endH, endM] = endTime.split(':').map(Number);
    return endH * 60 + endM - (startH * 60 + startM);
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }
}
