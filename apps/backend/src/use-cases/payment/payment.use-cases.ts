import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Payment } from '@domain/payment/payment.entity';
import { PaymentRepository, PAYMENT_REPOSITORY } from '@domain-services/financial/payment.repository';
import { BillingRepository, BILLING_REPOSITORY } from '@domain-services/financial/billing.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { NotificationService } from '@domain-services/platform/notification.service';
import { TenantContext } from '@shared/tenant-context';
import { SessionRepository, SESSION_REPOSITORY } from '@domain-services/patient-ops/session.repository';
import { DomainEvent } from '@domain/shared/domain-event';

export interface RegistrarPagamentoInput {
  billingId: string;
  amount: number;
  idempotencyKey: string;
}

/**
 * RegistrarPagamentoUseCase — RF-072, RF-073, RNF-008, Teste Crítico #8.
 *
 * Idempotência em DUAS camadas, nunca uma só:
 * 1. Aqui: consulta explícita por idempotencyKey ANTES de criar — evita
 *    trabalho desnecessário no caso comum.
 * 2. PrismaPaymentRepository.save(): constraint @unique no banco — rede de
 *    segurança real contra corrida (dois requests com a mesma key
 *    simultaneamente, onde a checagem em (1) passaria para os dois).
 *
 * Ao confirmar, também quita a Cobrança correspondente (billing.status:
 * Confirmado → Quitada) — dar baixa nunca é um passo manual separado
 * (06-UX/04-Fluxo-Financeiro.md, "Pipeline financeiro completo", passo 4).
 */
@Injectable()
export class RegistrarPagamentoUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly paymentRepo: PaymentRepository,
    @Inject(BILLING_REPOSITORY) private readonly billingRepo: BillingRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessionRepo: SessionRepository,
    private readonly auditService: AuditService,
    private readonly notificationService: NotificationService,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(input: RegistrarPagamentoInput): Promise<Payment> {
    const existing = await this.paymentRepo.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return existing; // requisição repetida — devolve o resultado da primeira execução, nunca duplica
    }

    const billing = await this.billingRepo.findById(input.billingId);
    if (!billing) {
      throw new NotFoundException('Cobrança não encontrada.');
    }

    const payment = Payment.create({
      id: randomUUID(),
      tenantId: this.tenantContext.tenantId,
      billingId: input.billingId,
      amount: input.amount,
      method: 'pix',
      idempotencyKey: input.idempotencyKey,
    });

    payment.reconcile(billing.amount); // Confirmado se bater, Divergente se não — nunca decide sozinho (Princípio 03)
    await this.paymentRepo.save(payment); // pode lançar DUPLICATE_PAYMENT (defesa de banco)
    const paymentEvents = payment.pullDomainEvents();
    await this.auditService.recordAll(paymentEvents); // Módulo 10
    await this.notificationService.process(paymentEvents, { billingId: billing.id, amount: billing.amount }); // Epic 12 (AD-021)

    if (payment.state === 'Confirmado') {
      billing.transitionTo('Quitada'); // dar baixa é automático, junto da confirmação — nunca passo manual à parte
      await this.billingRepo.save(billing);

      // AD-009 (ADR-0052): exatamente no mesmo gatilho que quita a Billing,
      // todas as Sessions vinculadas transicionam Faturada → Recebida —
      // nunca antes (payment Divergente não quita Billing nem Session).
      const sessionEvents: DomainEvent[] = [];
      const sessionIds = await this.billingRepo.findSessionIdsByBillingId(billing.id);
      for (const sessionId of sessionIds) {
        const session = await this.sessionRepo.findById(sessionId);
        if (!session) {
          throw new NotFoundException(`Sessão ${sessionId} não encontrada.`);
        }
        session.transitionTo('Recebida');
        await this.sessionRepo.save(session);
        sessionEvents.push(...session.pullDomainEvents());
      }

      await this.auditService.recordAll([...billing.pullDomainEvents(), ...sessionEvents]); // Módulo 10
    }

    return payment;
  }
}

@Injectable()
export class ConsultarPagamentoUseCase {
  constructor(@Inject(PAYMENT_REPOSITORY) private readonly repo: PaymentRepository) {}

  async execute(id: string): Promise<Payment> {
    const payment = await this.repo.findById(id);
    if (!payment) throw new NotFoundException('Pagamento não encontrado.');
    return payment;
  }
}

@Injectable()
export class EstornarPagamentoUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly repo: PaymentRepository,
    private readonly consultarPagamento: ConsultarPagamentoUseCase,
    private readonly auditService: AuditService,
  ) {}

  async execute(id: string): Promise<Payment> {
    const payment = await this.consultarPagamento.execute(id);
    payment.transitionTo('Estornado');
    await this.repo.save(payment);
    await this.auditService.recordAll(payment.pullDomainEvents()); // retrofit da revisão geral — fecha o M10
    return payment;
  }
}
