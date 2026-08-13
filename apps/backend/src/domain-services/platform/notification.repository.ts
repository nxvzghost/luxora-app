import { Notification } from '@domain/notification/notification.entity';

/**
 * NotificationRepository — porta (interface). Epic 12 (AD-021).
 * Mesmo padrão de AuditLogRepository (mesmo diretório, mesma natureza de
 * registro tenant-scoped) para leitura/listagem; create/markAsRead/
 * countUnread são métodos mínimos explícitos, sem um save() genérico —
 * decisão de escopo aprovada para o MVP.
 */
export interface NotificationRepository {
  create(notification: Notification): Promise<void>;
  findById(id: string): Promise<Notification | null>;
  findByTenant(params?: { cursor?: string; limit?: number }): Promise<Notification[]>;
  countUnreadByTenant(): Promise<number>;
  /** Idempotente: sem efeito se a Notification já estiver lida ou não existir no tenant atual. */
  markAsRead(id: string): Promise<void>;
}

export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');
