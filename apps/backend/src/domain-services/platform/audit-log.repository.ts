export interface AuditLogEntry {
  id: string;
  tenantId: string;
  userId: string | null;
  actorType: 'user' | 'ai_agent' | 'system';
  action: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown> | null;
  result: 'success' | 'failure';
}

export interface AuditLogRepository {
  record(entry: Omit<AuditLogEntry, 'id'>): Promise<void>;
  findByTenant(params?: { cursor?: string; limit?: number }): Promise<AuditLogEntry[]>;
}

export const AUDIT_LOG_REPOSITORY = Symbol('AUDIT_LOG_REPOSITORY');
