import { Injectable, Inject } from '@nestjs/common';
import { AuditLogRepository, AUDIT_LOG_REPOSITORY, AuditLogEntry } from '@domain-services/platform/audit-log.repository';

@Injectable()
export class ConsultarAuditLogUseCase {
  constructor(@Inject(AUDIT_LOG_REPOSITORY) private readonly repo: AuditLogRepository) {}

  async execute(params?: { cursor?: string; limit?: number }): Promise<AuditLogEntry[]> {
    return this.repo.findByTenant(params);
  }
}
