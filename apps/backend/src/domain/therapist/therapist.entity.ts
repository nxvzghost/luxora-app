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
 *
 * ADR-0040 (PD-001 — Motor de Disponibilidade): `availability` foi removido
 * daqui. Therapist não sabe mais nada sobre sua própria agenda — quem
 * possui essa responsabilidade agora é `AvailabilityCalendar`
 * (domain/availability/), referenciando este Terapeuta por `therapistId`,
 * nunca o contrário.
 */
export class TherapistUpdatedEvent extends DomainEvent {
  declare readonly action: string;

  constructor(entityId: string, tenantId: string, action: string) {
    super('TerapeutaAtualizado', entityId, tenantId, { action });
  }
}

export interface TherapistProps {
  id: string;
  tenantId: string;
  name: string;
  specialty?: string;
  phone?: string;
}

export class Therapist {
  private _pendingEvents: DomainEvent[] = [];

  private constructor(private readonly props: TherapistProps) {}

  static create(props: TherapistProps): Therapist {
    if (!props.name.trim()) {
      throw new Error('Nome do terapeuta é obrigatório.');
    }
    return new Therapist({ ...props });
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
