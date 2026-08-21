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
  /**
   * Idempotente quanto ao readAt (chamar novamente numa Notification já lida
   * não sobrescreve o timestamp original). Lança NotFoundException se o id
   * não existir no tenant atual — mesmo contrato de recurso singular usado
   * em todo o projeto (ex.: ConsultarPagamentoUseCase).
   */
  markAsRead(id: string): Promise<Notification>;
}

export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');
