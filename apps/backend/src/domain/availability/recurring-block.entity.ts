import { DomainEvent } from '../shared/domain-event';

export interface RecurringBlockProps {
  id: string;
  tenantId: string;
  patientId: string;
  therapistId: string; // referência, nunca posse — mesmo princípio de AvailabilityCalendar/ClinicHoliday (ADR-0040)
  firstOccurrence: Date;
  intervalDays: number; // 7 = semanal, 14 = quinzenal
  modality: 'presencial' | 'online';
  renewalMode: 'automatic' | 'manual';
}

/**
 * PD-001 Fase 2, C4.1 — mesmo padrão de evento único "aconteceu" já usado
 * por `ClinicHolidayCreatedEvent`/`AvailabilityCalendarUpdatedEvent`. Nasce
 * junto com o primeiro Caso de Uso de escrita (`CriarRecurringBlockUseCase`)
 * — decisão explícita de não introduzir a infraestrutura de eventos
 * isolada, sem nenhum fluxo real que a use (C1 deixou isso condicionado a
 * "quando o Caso de Uso de criar existir de verdade").
 */
export class RecurringBlockCreatedEvent extends DomainEvent {
  declare readonly patientId: string;
  declare readonly therapistId: string;
  declare readonly firstOccurrence: Date;
  declare readonly intervalDays: number;

  constructor(
    entityId: string,
    tenantId: string,
    patientId: string,
    therapistId: string,
    firstOccurrence: Date,
    intervalDays: number,
  ) {
    super('BlocoRecorrenteCriado', entityId, tenantId, { patientId, therapistId, firstOccurrence, intervalDays });
  }
}

/**
 * RecurringBlock — PD-001 Fase 2, C1. Representa "paciente X toda terça
 * 14h" como conceito de domínio próprio — fonte de verdade da série, não
 * uma lista de `Appointment`s já materializados (ver
 * docs/11-Product-Decisions/PD-001-Motor-de-Disponibilidade/04-Bounded-Context-e-Dominio.md).
 *
 * DECISÃO ARQUITETURAL (PD-001 Fase 2, C1 — registrada explicitamente antes
 * desta implementação, após análise comparativa formal): Aggregate Root
 * independente, NÃO aninhado em `AvailabilityCalendar`. Referencia
 * `patientId` e `therapistId`, nunca os possui — mesmo padrão de
 * `ClinicHoliday` (que referencia `tenantId` sem ser aninhado em `Clinic`).
 * Motivo: um `RecurringBlock` pertence à relação Paciente-Terapeuta, um
 * limite de consistência que `AvailabilityCalendar` (estritamente por
 * Terapeuta) não cobre sozinho. A integração com o Motor de Disponibilidade
 * ocorre por consulta explícita futura, nunca por composição do agregado.
 *
 * Escopo original de C1: domínio puro, sem I/O, sem Repository, sem eventos
 * de domínio — condicionado explicitamente a "quando o Caso de Uso de criar
 * existir de verdade". C4.1 é esse momento: `markCreated()` é o único
 * método mutador, análogo a `transitionTo()` em outras entidades — nenhuma
 * semântica de pausa/cancelamento de ocorrências já materializadas ainda
 * (continua sem decisão de produto aprovada).
 */
export class RecurringBlock {
  private _pendingEvents: DomainEvent[] = [];

  private constructor(private readonly props: RecurringBlockProps) {}

  static create(props: RecurringBlockProps): RecurringBlock {
    if (!Number.isInteger(props.intervalDays) || props.intervalDays <= 0) {
      throw new Error(`intervalDays deve ser um número inteiro positivo: ${props.intervalDays}.`);
    }
    return new RecurringBlock(props);
  }

  static reconstitute(props: RecurringBlockProps): RecurringBlock {
    return new RecurringBlock(props);
  }

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get patientId(): string {
    return this.props.patientId;
  }

  get therapistId(): string {
    return this.props.therapistId;
  }

  get firstOccurrence(): Date {
    return this.props.firstOccurrence;
  }

  get intervalDays(): number {
    return this.props.intervalDays;
  }

  get modality(): 'presencial' | 'online' {
    return this.props.modality;
  }

  get renewalMode(): 'automatic' | 'manual' {
    return this.props.renewalMode;
  }

  /**
   * Enfileira o evento de auditoria de criação. `create()` (fábrica
   * estática) nunca enfileira eventos por si só — mesma regra universal do
   * projeto (ver `ClinicHoliday.markCreated()`/`Patient.create()`). Quem
   * decide que a criação aconteceu de fato é o Caso de Uso, chamando este
   * método logo após `create()`.
   */
  markCreated(): void {
    this._pendingEvents.push(
      new RecurringBlockCreatedEvent(
        this.props.id,
        this.props.tenantId,
        this.props.patientId,
        this.props.therapistId,
        this.props.firstOccurrence,
        this.props.intervalDays,
      ),
    );
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }
}
