/**
 * Entidade Notificação — Epic 12 (AD-021). MVP: tenant-wide (sem
 * destinatário por usuário), gatilho único (pagamento divergente).
 *
 * Diferente das demais entidades de domínio deste codebase, Notification
 * NÃO emite DomainEvent/pullDomainEvents() — ela é o consumidor terminal do
 * pipeline (é gerada a partir do evento de outra entidade, ex.:
 * PaymentStateChangedEvent), e nada no escopo aprovado do MVP reage a um
 * evento próprio de Notification. Adicionar esse mecanismo sem nenhum
 * consumidor seria cerimônia morta.
 */
export interface NotificationProps {
  id: string;
  tenantId: string;
  type: string;
  title: string;
  message: string;
  entityType: string;
  entityId: string;
  readAt: Date | null;
  createdAt: Date;
}

export class Notification {
  private _readAt: Date | null;

  private constructor(private readonly props: NotificationProps) {
    this._readAt = props.readAt;
  }

  static create(props: Omit<NotificationProps, 'readAt' | 'createdAt'>): Notification {
    return new Notification({ ...props, readAt: null, createdAt: new Date() });
  }

  static reconstitute(props: NotificationProps): Notification {
    return new Notification(props);
  }

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get type(): string {
    return this.props.type;
  }

  get title(): string {
    return this.props.title;
  }

  get message(): string {
    return this.props.message;
  }

  get entityType(): string {
    return this.props.entityType;
  }

  get entityId(): string {
    return this.props.entityId;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get readAt(): Date | null {
    return this._readAt;
  }

  get isRead(): boolean {
    return this._readAt !== null;
  }

  /**
   * Idempotente: chamar novamente numa Notification já lida não altera o
   * readAt original nem lança erro — sem essa garantia, uma segunda
   * requisição (ex.: duplo clique no frontend) sobrescreveria o horário
   * real da primeira leitura.
   */
  markAsRead(): void {
    if (this._readAt !== null) {
      return;
    }
    this._readAt = new Date();
  }
}
