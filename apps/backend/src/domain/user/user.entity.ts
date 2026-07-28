import { DomainEvent } from '../shared/domain-event';

/**
 * User — AD-001 (Epic 5). Mesmo padrão minimalista de `Therapist`: sem
 * máquina de estados formal (desativação é um soft-delete, não uma jornada
 * de estados), um único evento genérico com `action`.
 */
export class UserUpdatedEvent extends DomainEvent {
  declare readonly action: string;

  constructor(entityId: string, tenantId: string, action: string) {
    super('UsuarioAtualizado', entityId, tenantId, { action });
  }
}

/**
 * Deliberadamente SEM `super_admin` — este tipo é usado por toda a
 * superfície de API de usuários (DTOs, casos de uso). `super_admin` só
 * existe no schema Prisma/JWT/RolesGuard para contas de operação da própria
 * Luxora, nunca atribuível via API — ver AD-001, seção de segurança.
 */
export type AssignableUserRole = 'admin' | 'therapist';

export interface UserProps {
  id: string;
  tenantId: string;
  email: string;
  passwordHash: string;
  role: AssignableUserRole;
  /** Só relevante quando role === 'therapist' — referência, nunca posse (mesmo princípio de AvailabilityCalendar/ADR-0040). */
  therapistId?: string;
  /**
   * Soft-delete — já existia no schema antes desta AD e já era respeitado
   * por `AuthService.login()`. Reaproveitado integralmente, nunca duplicado
   * por um segundo campo `isActive`.
   */
  deletedAt?: Date | null;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class User {
  private _pendingEvents: DomainEvent[] = [];

  private constructor(private readonly props: UserProps) {}

  static create(props: Omit<UserProps, 'deletedAt'>): User {
    User.validateEmail(props.email);
    User.validateRole(props.role, props.therapistId);
    return new User({ ...props, deletedAt: null });
  }

  static reconstitute(props: UserProps): User {
    return new User(props);
  }

  private static validateEmail(email: string): void {
    if (!EMAIL_REGEX.test(email)) {
      throw new Error(`E-mail inválido: ${email}.`);
    }
  }

  /** `therapistId` é obrigatório quando role === 'therapist' — nunca presente quando role === 'admin' (invariante, não convenção de DTO). */
  private static validateRole(role: AssignableUserRole, therapistId?: string): void {
    if (role === 'therapist' && !therapistId) {
      throw new Error('Usuário com papel "therapist" precisa referenciar um Terapeuta (therapistId).');
    }
    if (role === 'admin' && therapistId) {
      throw new Error('Usuário com papel "admin" não pode referenciar um Terapeuta.');
    }
  }

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get email(): string {
    return this.props.email;
  }

  get passwordHash(): string {
    return this.props.passwordHash;
  }

  get role(): AssignableUserRole {
    return this.props.role;
  }

  get therapistId(): string | undefined {
    return this.props.therapistId;
  }

  get isActive(): boolean {
    return this.props.deletedAt == null;
  }

  /** Valor exato decidido pelo domínio (`deactivate()`/`reactivate()`) — o repositório nunca gera seu próprio timestamp para persistir. */
  get deletedAt(): Date | null {
    return this.props.deletedAt ?? null;
  }

  changeRole(role: AssignableUserRole, therapistId?: string): void {
    User.validateRole(role, therapistId);
    this.props.role = role;
    this.props.therapistId = therapistId;
    this._pendingEvents.push(new UserUpdatedEvent(this.props.id, this.props.tenantId, 'papel_alterado'));
  }

  deactivate(): void {
    if (!this.isActive) {
      throw new Error('Usuário já está desativado.');
    }
    this.props.deletedAt = new Date();
    this._pendingEvents.push(new UserUpdatedEvent(this.props.id, this.props.tenantId, 'desativado'));
  }

  reactivate(): void {
    if (this.isActive) {
      throw new Error('Usuário já está ativo.');
    }
    this.props.deletedAt = null;
    this._pendingEvents.push(new UserUpdatedEvent(this.props.id, this.props.tenantId, 'reativado'));
  }

  /** Emitido só pelo Caso de Uso, logo após `create()` — mesmo padrão de `ClinicHoliday.markCreated()`. */
  markCreated(): void {
    this._pendingEvents.push(new UserUpdatedEvent(this.props.id, this.props.tenantId, 'criado'));
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }
}
