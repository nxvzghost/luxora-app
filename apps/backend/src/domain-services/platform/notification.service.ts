import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DomainEvent } from '@domain/shared/domain-event';
import { PaymentStateChangedEvent } from '@domain/payment/payment.entity';
import { Notification } from '@domain/notification/notification.entity';
import { NotificationRepository, NOTIFICATION_REPOSITORY } from './notification.repository';

export interface PaymentDivergenteContext {
  billingId: string;
  amount: number;
}

/**
 * NotificationService — Epic 12 (AD-021). Traduz DomainEvent em Notification
 * tenant-wide, síncrono, sem fila própria (mesmo MVP de AuditService, mas
 * seletivo: só reage a PaymentStateChangedEvent com toState === Divergente
 * — os demais eventos do array passam direto, sem gerar Notification).
 *
 * O evento não carrega billingId/amount (só fromState/toState/entityId/
 * tenantId) — por isso o contexto vem por parâmetro separado, montado pelo
 * caller a partir do Billing já em escopo, em vez de estender o DomainEvent.
 */
@Injectable()
export class NotificationService {
  constructor(@Inject(NOTIFICATION_REPOSITORY) private readonly repo: NotificationRepository) {}

  async process(events: DomainEvent[], context: PaymentDivergenteContext): Promise<void> {
    for (const event of events) {
      if (!(event instanceof PaymentStateChangedEvent) || event.toState !== 'Divergente') {
        continue;
      }

      const notification = Notification.create({
        id: randomUUID(),
        tenantId: event.tenantId,
        type: 'payment_divergent',
        title: 'Pagamento divergente',
        message: `O pagamento ${event.entityId} foi registrado com valor divergente do esperado para a cobrança ${context.billingId} (valor esperado: R$ ${context.amount.toFixed(2)}).`,
        entityType: 'Payment',
        entityId: event.entityId,
      });

      await this.repo.create(notification);
    }
  }
}
