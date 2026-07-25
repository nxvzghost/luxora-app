import { DomainEvent } from '../shared/domain-event';

export interface ClinicHolidayProps {
  id: string;
  tenantId: string; // referência à Clínica inteira — nunca a um Terapeuta específico
  from: Date;
  to: Date;
  reason?: string;
}

/**
 * PD-001 Fase 2, B5 (revisão pós-auditoria): mesmo padrão de evento único
 * "algo aconteceu" já usado por `AvailabilityCalendarUpdatedEvent`,
 * `TherapistUpdatedEvent`, `ClinicUpdatedEvent` — não um FSM de estados
 * (`ClinicHoliday` não tem estados intermediários, só existe ou não existe).
 */
export class ClinicHolidayCreatedEvent extends DomainEvent {
  declare readonly from: Date;
  declare readonly to: Date;
  declare readonly reason?: string;

  constructor(entityId: string, tenantId: string, from: Date, to: Date, reason?: string) {
    super('FeriadoClinicaCriado', entityId, tenantId, { from, to, reason });
  }
}

/**
 * Nenhuma outra entidade do projeto modela remoção definitiva (todas usam
 * transição de estado — ver PatientStateChangedEvent) — `ClinicHoliday` é a
 * primeira a ser de fato apagada (ver `RemoverFeriadoUseCase`). Sem campo
 * mutável para representar "removido", o próprio evento é o registro do
 * acontecimento — sem `extraFields`, o `id` e `tenantId` da base já bastam.
 */
export class ClinicHolidayRemovedEvent extends DomainEvent {
  constructor(entityId: string, tenantId: string) {
    super('FeriadoClinicaRemovido', entityId, tenantId);
  }
}

/**
 * ClinicHoliday — feriado/bloqueio no nível da Clínica inteira (PD-001 Fase
 * 2, B2). Entidade própria do Bounded Context `Availability`, referenciando
 * `tenantId` — deliberadamente NÃO aninhada em `Clinic`: feriado é regra de
 * disponibilidade, não configuração administrativa da Clínica. Mantém o
 * Bounded Context coeso junto de `AvailabilityCalendar`,
 * `AvailabilityException` e, futuramente, `RecurringBlock` — evita que o
 * Motor dependa da estrutura interna do Aggregate `Clinic`.
 *
 * `reason` é metadado puro, mesmo tratamento de `AvailabilityException`
 * (ver availability-calendar.entity.ts) — nenhuma regra de domínio depende
 * dele.
 *
 * INVARIANTE (PD-001 Fase 2, B2): `ClinicHoliday` representa um período de
 * indisponibilidade da Clínica e NÃO possui autoridade para alterar a
 * disponibilidade por si só nesta etapa. Até que a camada de aplicação
 * passe a consultá-la, a entidade permanece independente e sem efeito
 * operacional sobre o Motor de Disponibilidade — `AvailabilityCalendar`
 * não a referencia, e esta classe não referencia `AvailabilityCalendar`,
 * `ScheduleSlot` ou qualquer outro conceito do Motor. A única capacidade de
 * CONSULTA que expõe é `overlaps()`, uma checagem de intervalo pura —
 * `markCreated()`/`markRemoved()` (PD-001 Fase 2, revisão pós-B5) não
 * alteram esse invariante: não decidem nada sobre o Motor, apenas registram
 * o evento de auditoria a ser emitido, mesmo papel que `setWindows()` tem
 * em `AvailabilityCalendar`.
 */
export class ClinicHoliday {
  private _pendingEvents: DomainEvent[] = [];

  private constructor(private readonly props: ClinicHolidayProps) {}

  static create(props: ClinicHolidayProps): ClinicHoliday {
    if (props.from >= props.to) {
      throw new Error(
        `Início do feriado deve ser anterior ao fim: ${props.from.toISOString()}-${props.to.toISOString()}.`,
      );
    }
    return new ClinicHoliday(props);
  }

  static reconstitute(props: ClinicHolidayProps): ClinicHoliday {
    return new ClinicHoliday(props);
  }

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get from(): Date {
    return this.props.from;
  }

  get to(): Date {
    return this.props.to;
  }

  get reason(): string | undefined {
    return this.props.reason;
  }

  /** Verdadeiro se `[from, to)` colide com o intervalo deste feriado — nunca depende de `reason`. */
  overlaps(from: Date, to: Date): boolean {
    return from < this.props.to && this.props.from < to;
  }

  /**
   * Enfileira o evento de auditoria de criação. `create()` (fábrica
   * estática) nunca enfileira eventos por si só — mesma regra em todas as
   * outras entidades do projeto (ex: `Patient.create()`); quem decide que a
   * criação aconteceu de fato é o Caso de Uso, chamando este método logo
   * após `create()` (mesmo padrão de `CadastrarPacienteUseCase`, que chama
   * `transitionTo()` logo após `Patient.create()`).
   */
  markCreated(): void {
    this._pendingEvents.push(
      new ClinicHolidayCreatedEvent(this.props.id, this.props.tenantId, this.props.from, this.props.to, this.props.reason),
    );
  }

  /** Enfileira o evento de auditoria de remoção — chamado pelo Caso de Uso antes do `delete()` no Repository. */
  markRemoved(): void {
    this._pendingEvents.push(new ClinicHolidayRemovedEvent(this.props.id, this.props.tenantId));
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }
}
