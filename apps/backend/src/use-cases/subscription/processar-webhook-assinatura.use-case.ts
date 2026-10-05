import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  ClinicSubscriptionRepository,
  CLINIC_SUBSCRIPTION_REPOSITORY,
} from '@domain-services/subscription/clinic-subscription.repository';
import {
  WebhookEventRepository,
  WEBHOOK_EVENT_REPOSITORY,
} from '@domain-services/subscription/webhook-event.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { InvalidStateTransitionError } from '@domain/shared/state-machine';
import { TenantContext } from '@shared/tenant-context';

export interface AsaasWebhookPayload {
  id: string;
  event: string;
  subscription?: { id: string };
  payment?: { subscription?: string };
}

const EVENT_TO_STATUS: Record<string, 'Active' | 'PastDue' | 'Cancelled'> = {
  PAYMENT_CONFIRMED: 'Active',
  PAYMENT_RECEIVED: 'Active',
  PAYMENT_OVERDUE: 'PastDue',
  SUBSCRIPTION_DELETED: 'Cancelled',
};

/**
 * ProcessarWebhookAssinaturaUseCase — Módulo 17.
 *
 * Idempotência OBRIGATÓRIA por id do evento (a própria Asaas avisa:
 * entrega "at least once") — mesmo padrão já usado em Payment (M09) e
 * MessageLog (M11), aplicado aqui pela primeira vez a um webhook de
 * entrada, não de saída.
 *
 * DEFEITO REAL ENCONTRADO E CORRIGIDO NESTA IMPLEMENTAÇÃO: AuditService
 * depende de TenantContext inicializado (normalmente feito por
 * JwtAuthGuard) — mas este webhook não tem JWT nenhum, é a Asaas chamando
 * diretamente. Sem correção, a chamada a auditService.recordAll() abaixo
 * lançaria erro ("tenantId não inicializado") na primeira tentativa real.
 * Corrigido inicializando o TenantContext manualmente, a partir do
 * tenantId já resolvido pela própria assinatura encontrada — mesmo
 * TenantContext é Scope.REQUEST (Módulo 01), então essa inicialização
 * vale só para esta requisição de webhook, nunca vaza para outra.
 */
@Injectable()
export class ProcessarWebhookAssinaturaUseCase {
  private readonly logger = new Logger(ProcessarWebhookAssinaturaUseCase.name);

  constructor(
    @Inject(CLINIC_SUBSCRIPTION_REPOSITORY) private readonly subscriptionRepo: ClinicSubscriptionRepository,
    @Inject(WEBHOOK_EVENT_REPOSITORY) private readonly webhookRepo: WebhookEventRepository,
    private readonly auditService: AuditService,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(payload: AsaasWebhookPayload): Promise<void> {
    // Fase 3 da auditoria — a chamada já passou pelo AsaasWebhookGuard, mas
    // o corpo não tem DTO: sem `id` ou `event` não há como deduplicar nem
    // agir. Antes, isso estourava na consulta de idempotência e a resposta
    // era 500 — a Asaas reenviaria o mesmo corpo inútil até pausar a fila
    // de webhooks. Confirma o recebimento e não altera nada.
    if (typeof payload?.id !== 'string' || !payload.id || typeof payload.event !== 'string' || !payload.event) {
      this.logger.warn('Webhook Asaas sem id ou sem tipo de evento — ignorado, nada alterado.');
      return;
    }

    if (await this.webhookRepo.wasProcessed(payload.id)) {
      return;
    }

    const subscriptionId = payload.subscription?.id ?? payload.payment?.subscription;
    const newStatus = EVENT_TO_STATUS[payload.event];

    if (!subscriptionId || !newStatus) {
      await this.webhookRepo.markProcessed(payload.id, payload.event);
      this.logger.log(`Evento ${payload.event} recebido, sem ação mapeada — ignorado deliberadamente.`);
      return;
    }

    const subscription = await this.subscriptionRepo.findByAsaasSubscriptionId(subscriptionId);
    if (!subscription) {
      await this.webhookRepo.markProcessed(payload.id, payload.event);
      this.logger.warn(`Webhook para assinatura Asaas ${subscriptionId} sem correspondente local — ignorado.`);
      return;
    }

    // `Active` é tratado à parte, nunca pelo guard `status !== newStatus`
    // abaixo: DEFEITO REAL ENCONTRADO E CORRIGIDO NESTA SPRINT — antes,
    // um PAYMENT_CONFIRMED/PAYMENT_RECEIVED chegando para uma assinatura
    // JÁ Active (uma renovação recorrente real, o caso normal e mais
    // comum de todos) caía no guard e não fazia nada. `confirmPayment()`
    // cobre ativação e renovação com o mesmo método, avança
    // `currentPeriodEnd` (CEO-DEC-003.6) e aplica um downgrade agendado
    // se o ciclo virou (CEO-DEC-002.5).
    try {
      if (newStatus === 'Active') {
        subscription.confirmPayment();
      } else if (subscription.status !== newStatus) {
        subscription.transitionTo(newStatus);
      } else {
        await this.webhookRepo.markProcessed(payload.id, payload.event);
        return;
      }
    } catch (err) {
      if (!(err instanceof InvalidStateTransitionError)) {
        throw err;
      }
      // Fase 3 da auditoria — ACHADO REAL: o evento é legítimo, mas não
      // cabe no estado atual (ex.: PAYMENT_RECEIVED da liquidação de um
      // cartão chegando depois de a assinatura já estar Cancelled, que não
      // admite nenhuma transição). Antes, a exceção virava 500: a Asaas
      // reenviaria o mesmo evento e, após 15 falhas seguidas, interromperia
      // a fila de webhooks da conta inteira — de todas as clínicas. A
      // entidade valida a transição antes de mudar qualquer coisa, então
      // nada foi alterado: confirma o recebimento e registra o evento.
      await this.webhookRepo.markProcessed(payload.id, payload.event);
      this.logger.warn(
        `Evento ${payload.event} não se aplica à assinatura ${subscription.id} no estado ${subscription.status} — confirmado sem alterar nada.`,
      );
      return;
    }

    await this.subscriptionRepo.save(subscription);
    // Inicialização manual — ver nota da classe acima.
    this.tenantContext.set(subscription.tenantId, 'system');
    await this.auditService.recordAll(subscription.pullDomainEvents(), 'system');
    await this.webhookRepo.markProcessed(payload.id, payload.event);
  }
}
