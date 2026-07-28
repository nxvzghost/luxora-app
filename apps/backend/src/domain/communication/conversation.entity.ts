import { DomainEvent } from '../shared/domain-event';

/**
 * Conversation — ADR-0053 (AD-007/AD-010), versão mínima de PD-008.
 *
 * Agregado de IDENTIDADE/AGRUPAMENTO — deliberadamente SEM máquina de
 * estados (sem Ativa/Escalada/Encerrada, ao contrário do desenho mais rico
 * que PD-008 havia esboçado). Uma Conversation existe para dar a
 * `Message`s de entrada/saída um lugar de residência entre chamadas do
 * pipeline de IA — nada além disso nesta AD (escalonamento humano e
 * fechamento de conversa ficam fora de escopo, restrições aprovadas).
 *
 * Identidade natural: uma Conversation por par (tenantId, phoneNumber) —
 * ver ConversationRepository.findByTenantAndPhone().
 */
export type MessageDirection = 'entrada' | 'saida';

export class ConversationMessageRecordedEvent extends DomainEvent {
  declare readonly direction: MessageDirection;
  declare readonly messageId: string;

  constructor(conversationId: string, tenantId: string, messageId: string, direction: MessageDirection) {
    super('MensagemRegistrada', conversationId, tenantId, { messageId, direction });
  }
}

export interface MessageProps {
  id: string;
  conversationId: string;
  tenantId: string;
  direction: MessageDirection;
  content: string;
  /** WAMID — só preenchido em mensagens de entrada; chave de idempotência do webhook. */
  externalId?: string | null;
  status?: string;
  createdAt?: Date;
}

export class Message {
  private constructor(private readonly props: Required<Omit<MessageProps, 'externalId'>> & { externalId: string | null }) {}

  static reconstitute(props: MessageProps): Message {
    return new Message({
      ...props,
      externalId: props.externalId ?? null,
      status: props.status ?? 'enviada',
      createdAt: props.createdAt ?? new Date(),
    });
  }

  get id(): string {
    return this.props.id;
  }

  get conversationId(): string {
    return this.props.conversationId;
  }

  get direction(): MessageDirection {
    return this.props.direction;
  }

  get content(): string {
    return this.props.content;
  }

  get externalId(): string | null {
    return this.props.externalId;
  }

  get status(): string {
    return this.props.status;
  }
}

export interface ConversationProps {
  id: string;
  tenantId: string;
  phoneNumber: string;
  patientId?: string | null;
  createdAt?: Date;
}

export class Conversation {
  private _pendingEvents: DomainEvent[] = [];
  private _pendingMessages: Message[] = [];

  private constructor(
    private readonly props: Required<Omit<ConversationProps, 'patientId'>> & { patientId: string | null },
  ) {}

  /** Único ponto de criação — sempre nasce sem Patient vinculado (resolvido à parte, ver ADR-0053 §2.4). */
  static create(props: { id: string; tenantId: string; phoneNumber: string; patientId?: string | null }): Conversation {
    return new Conversation({
      id: props.id,
      tenantId: props.tenantId,
      phoneNumber: props.phoneNumber,
      patientId: props.patientId ?? null,
      createdAt: new Date(),
    });
  }

  static reconstitute(props: ConversationProps): Conversation {
    return new Conversation({
      ...props,
      patientId: props.patientId ?? null,
      createdAt: props.createdAt ?? new Date(),
    });
  }

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get phoneNumber(): string {
    return this.props.phoneNumber;
  }

  get patientId(): string | null {
    return this.props.patientId;
  }

  /**
   * Adiciona uma Message nova (entrada ou saída) e enfileira o evento de
   * domínio correspondente — substitui o padrão anterior de
   * `AiInteractionAuditEvent` fabricado dentro do Use Case (achado de
   * PD-008): o evento agora nasce da própria entidade.
   */
  addMessage(input: { id: string; direction: MessageDirection; content: string; externalId?: string | null }): Message {
    const message = Message.reconstitute({
      id: input.id,
      conversationId: this.props.id,
      tenantId: this.props.tenantId,
      direction: input.direction,
      content: input.content,
      externalId: input.externalId ?? null,
    });
    this._pendingMessages.push(message);
    this._pendingEvents.push(
      new ConversationMessageRecordedEvent(this.props.id, this.props.tenantId, message.id, input.direction),
    );
    return message;
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }

  pullPendingMessages(): Message[] {
    const messages = this._pendingMessages;
    this._pendingMessages = [];
    return messages;
  }
}
