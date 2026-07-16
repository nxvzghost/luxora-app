import { Injectable, Inject } from '@nestjs/common';
import { DomainEvent } from '@domain/shared/domain-event';
import { AuditLogRepository, AUDIT_LOG_REPOSITORY } from './audit-log.repository';
import { TenantContext } from '@shared/tenant-context';

/**
 * AuditService — Módulo 10. Traduz DomainEvent (Módulo 02) em registro de
 * audit_log persistido.
 *
 * USO: todo Use Case que já chama `entity.pullDomainEvents()` deve passar
 * o resultado para `auditService.recordAll(events)` em vez de apenas
 * descartar (como vinha fazendo desde o Módulo 05 — comentário recorrente
 * "esvazia a fila... não acumula em memória" nunca persistia nada).
 *
 * RETROFIT CONCLUÍDO: todo Use Case que produz DomainEvent (patient,
 * therapist, clinic, appointment, billing, payment, subscription, AI) já
 * passa pullDomainEvents() para cá — confirmado por grep em toda
 * use-cases/, não só pelos exemplos citados aqui antes. Validado também
 * contra o Postgres real: PUT /therapists/:id/availability grava linha
 * real em audit_log com payload correto.
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject(AUDIT_LOG_REPOSITORY) private readonly repo: AuditLogRepository,
    private readonly tenantContext: TenantContext,
  ) {}

  async recordAll(events: DomainEvent[], actorType: 'user' | 'ai_agent' | 'system' = 'user'): Promise<void> {
    for (const event of events) {
      await this.repo.record({
        tenantId: event.tenantId,
        userId: actorType === 'user' && this.tenantContext.isInitialized ? this.tenantContext.userId : null,
        actorType,
        action: event.eventName,
        entityType: event.constructor.name.replace('Event', ''),
        entityId: event.entityId,
        payload: this.extractPayload(event),
        result: 'success',
      });
    }
  }

  private extractPayload(event: DomainEvent): Record<string, unknown> {
    const { eventName: _e, entityId: _id, tenantId: _t, occurredAt: _o, ...rest } = event as unknown as Record<
      string,
      unknown
    >;
    return rest;
  }
}
