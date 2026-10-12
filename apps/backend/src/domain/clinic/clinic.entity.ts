import { DomainEvent } from '../shared/domain-event';
import { isIanaTimeZoneName } from '../shared/time-zone';

/**
 * Clínica — representa o Tenant do ponto de vista de negócio (nome,
 * políticas configuráveis). O isolamento técnico (RLS, tenant_id) continua
 * sendo responsabilidade de Tenant/TenantContext — esta entidade nunca deve
 * ser confundida com aquele mecanismo, mesmo que ambos apontem para a mesma
 * linha em `tenant`/`clinic_settings` no banco.
 *
 * GAP ENCONTRADO NA REVISÃO GERAL: mesma lacuna do Therapist — Clinic
 * nunca emitia DomainEvent, então mudança de política (inclusive dado de
 * pagamento — pixKey/payeeName) nunca era auditada. Corrigido.
 */
export class ClinicUpdatedEvent extends DomainEvent {
  declare readonly action: string;

  constructor(entityId: string, tenantId: string, action: string, details: Record<string, unknown> = {}) {
    super('ClinicaAtualizada', entityId, tenantId, { ...details, action });
  }
}

export type BillingPolicy = 'per_session' | 'weekly' | 'monthly';

export interface ClinicProps {
  tenantId: string;
  name: string;
  defaultBillingPolicy: BillingPolicy;
  cancellationHoursLimit?: number;
  // Dívida acumulada desde os Módulos 07 e 11, fechada agora: os Use Cases
  // que precisavam desses 3 campos usavam PrismaService diretamente como
  // atalho, porque a entidade de Domain nunca os expôs.
  defaultSessionDurationMinutes: number;
  pixKey?: string;
  payeeName?: string;
  /**
   * AD-039 (ADR-0064) — fuso da clínica, nome da base IANA. Muda só por
   * `changeTimeZone()`.
   */
  timeZone: string;
}

export class Clinic {
  private _pendingEvents: DomainEvent[] = [];

  private constructor(private readonly props: ClinicProps) {}

  static reconstitute(props: ClinicProps): Clinic {
    return new Clinic(props);
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get name(): string {
    return this.props.name;
  }

  get defaultBillingPolicy(): BillingPolicy {
    return this.props.defaultBillingPolicy;
  }

  get cancellationHoursLimit(): number | undefined {
    return this.props.cancellationHoursLimit;
  }

  get defaultSessionDurationMinutes(): number {
    return this.props.defaultSessionDurationMinutes;
  }

  get pixKey(): string | undefined {
    return this.props.pixKey;
  }

  get payeeName(): string | undefined {
    return this.props.payeeName;
  }

  get timeZone(): string {
    return this.props.timeZone;
  }

  rename(newName: string): void {
    if (!newName.trim()) {
      throw new Error('Nome da clínica não pode ficar vazio.');
    }
    this.props.name = newName.trim();
    this._pendingEvents.push(new ClinicUpdatedEvent(this.props.tenantId, this.props.tenantId, 'nome_alterado'));
  }

  /**
   * AtualizarPoliticasClinica — RF-010 a RF-012 (Princípio 11 — Configuração
   * acima de Programação, ver 00-Principios-Arquiteturais.md).
   */
  updatePolicies(policies: {
    defaultBillingPolicy?: BillingPolicy;
    cancellationHoursLimit?: number;
    defaultSessionDurationMinutes?: number;
  }): void {
    if (policies.cancellationHoursLimit !== undefined && policies.cancellationHoursLimit < 0) {
      throw new Error('cancellationHoursLimit não pode ser negativo.');
    }
    if (policies.defaultSessionDurationMinutes !== undefined && policies.defaultSessionDurationMinutes <= 0) {
      throw new Error('defaultSessionDurationMinutes deve ser maior que zero.');
    }
    if (policies.defaultBillingPolicy) {
      this.props.defaultBillingPolicy = policies.defaultBillingPolicy;
    }
    if (policies.cancellationHoursLimit !== undefined) {
      this.props.cancellationHoursLimit = policies.cancellationHoursLimit;
    }
    if (policies.defaultSessionDurationMinutes !== undefined) {
      this.props.defaultSessionDurationMinutes = policies.defaultSessionDurationMinutes;
    }
    this._pendingEvents.push(new ClinicUpdatedEvent(this.props.tenantId, this.props.tenantId, 'politicas_alteradas'));
  }

  /** RF-020 (Faturamento) — dados de recebimento PIX, usados no template de cobrança (Módulo 11). */
  updatePaymentInfo(info: { pixKey?: string; payeeName?: string }): void {
    if (info.pixKey !== undefined) this.props.pixKey = info.pixKey;
    if (info.payeeName !== undefined) this.props.payeeName = info.payeeName;
    this._pendingEvents.push(new ClinicUpdatedEvent(this.props.tenantId, this.props.tenantId, 'dados_pagamento_alterados'));
  }

  /**
   * AD-039 (ADR-0064) — troca o fuso da clínica. Devolve `false`, sem evento,
   * quando o fuso informado já é o atual.
   *
   * Nada do que já está gravado é reescrito: consultas, exceções e horários
   * fixos são instantes e continuam os mesmos — o que muda é a hora de parede
   * em que passam a ser lidos. As janelas de atendimento ("09:00–18:00") e os
   * vencimentos são horas e datas de parede, e passam a valer no fuso novo.
   * O registro de auditoria leva o fuso anterior e o novo.
   */
  changeTimeZone(timeZone: string): boolean {
    if (!isIanaTimeZoneName(timeZone)) {
      throw new Error(`Fuso horário inválido: "${String(timeZone)}". Use o nome de uma zona da base IANA, como "America/Sao_Paulo".`);
    }
    if (timeZone === this.props.timeZone) return false;
    const previous = this.props.timeZone;
    this.props.timeZone = timeZone;
    this._pendingEvents.push(
      new ClinicUpdatedEvent(this.props.tenantId, this.props.tenantId, 'fuso_alterado', { fromTimeZone: previous, toTimeZone: timeZone }),
    );
    return true;
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }
}
