import { DomainEvent } from '../shared/domain-event';

/**
 * Terapeuta — diferente de Patient/Session/Billing/Payment, não tem máquina
 * de estados própria documentada em 01-Domain/03-Maquina-de-Estados.md.
 * Ainda assim vive como entidade de Domain pura (Princípio 01), com suas
 * próprias regras de validação — nunca um DTO anêmico.
 *
 * GAP ENCONTRADO NA REVISÃO GERAL: até esta correção, Therapist nunca
 * emitia DomainEvent nenhum (diferente de Patient/Appointment/Billing/
 * Payment) — o retrofit de auditoria do Módulo 10 nunca teve nada para
 * persistir aqui. Corrigido: mesmo mecanismo de pullDomainEvents() das
 * outras entidades, mesmo sem máquina de estados formal.
 */
export class TherapistUpdatedEvent extends DomainEvent {
  declare readonly action: string;

  constructor(entityId: string, tenantId: string, action: string) {
    super('TerapeutaAtualizado', entityId, tenantId, { action });
  }
}

export interface WeeklyAvailabilitySlot {
  dayOfWeek: number; // 0 = domingo … 6 = sábado
  startTime: string; // "HH:mm"
  endTime: string; // "HH:mm"
}

export interface TherapistProps {
  id: string;
  tenantId: string;
  name: string;
  specialty?: string;
  phone?: string;
  availability: WeeklyAvailabilitySlot[];
}

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class Therapist {
  private _pendingEvents: DomainEvent[] = [];

  private constructor(private readonly props: TherapistProps) {}

  static create(props: Omit<TherapistProps, 'availability'>): Therapist {
    if (!props.name.trim()) {
      throw new Error('Nome do terapeuta é obrigatório.');
    }
    return new Therapist({ ...props, availability: [] });
  }

  static reconstitute(props: TherapistProps): Therapist {
    return new Therapist(props);
  }

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get name(): string {
    return this.props.name;
  }

  get specialty(): string | undefined {
    return this.props.specialty;
  }

  get availability(): readonly WeeklyAvailabilitySlot[] {
    return this.props.availability;
  }

  /**
   * DefinirDisponibilidade — RF-019 a RF-022. Substitui a disponibilidade
   * semanal inteira (não faz merge parcial) — o Frontend sempre envia o
   * conjunto completo, evitando estado inconsistente entre slots antigos
   * e novos.
   */
  setAvailability(slots: WeeklyAvailabilitySlot[]): void {
    for (const slot of slots) {
      if (slot.dayOfWeek < 0 || slot.dayOfWeek > 6) {
        throw new Error(`dayOfWeek inválido: ${slot.dayOfWeek} (esperado 0-6).`);
      }
      if (!TIME_REGEX.test(slot.startTime) || !TIME_REGEX.test(slot.endTime)) {
        throw new Error(`Horário inválido em disponibilidade: ${slot.startTime}-${slot.endTime}.`);
      }
      if (slot.startTime >= slot.endTime) {
        throw new Error(`Horário de início deve ser anterior ao fim: ${slot.startTime}-${slot.endTime}.`);
      }
    }
    // Verifica sobreposição entre os próprios slots enviados — mesma
    // lógica de detecção já usada em domain/schedule/schedule-slot,
    // mas aqui operando sobre horário recorrente (string), não Date.
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        if (slots[i].dayOfWeek !== slots[j].dayOfWeek) continue;
        const overlap = slots[i].startTime < slots[j].endTime && slots[j].startTime < slots[i].endTime;
        if (overlap) {
          throw new Error(
            `Disponibilidade sobreposta no mesmo dia: ${slots[i].startTime}-${slots[i].endTime} e ${slots[j].startTime}-${slots[j].endTime}.`,
          );
        }
      }
    }
    this.props.availability = slots;
    this._pendingEvents.push(new TherapistUpdatedEvent(this.props.id, this.props.tenantId, 'disponibilidade_alterada'));
  }

  rename(newName: string): void {
    if (!newName.trim()) {
      throw new Error('Nome do terapeuta não pode ficar vazio.');
    }
    this.props.name = newName.trim();
    this._pendingEvents.push(new TherapistUpdatedEvent(this.props.id, this.props.tenantId, 'nome_alterado'));
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }
}
