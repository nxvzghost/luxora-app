import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Billing } from '@domain/billing/billing.entity';
import { BillingRepository, BILLING_REPOSITORY } from '@domain-services/financial/billing.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { TenantContext } from '@shared/tenant-context';
import { PatientRepository, PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { ClinicRepository, CLINIC_REPOSITORY } from '@domain-services/platform/clinic.repository';
import { MessageQueueProducer } from '@infrastructure/messaging/message-queue.producer';
import { buildBillingMessage } from '@use-cases/communication/templates/billing-message.template';

export interface GerarCobrancaInput {
  patientId: string;
  amount: number;
  dueDate: Date;
  sessionIds: string[]; // 1 ou N — modelo N:N via billing_session (03-Database/03-Relacionamentos.md)
}

/**
 * GerarCobrancaUseCase — RF-071. Aceita sessionIds com 1 ou N elementos,
 * refletindo a correção de modelagem já feita antes deste módulo (cobrança
 * por sessão avulsa = N:1; semanal/mensal = N:N via billing_session).
 */
@Injectable()
export class GerarCobrancaUseCase {
  constructor(
    @Inject(BILLING_REPOSITORY) private readonly repo: BillingRepository,
    private readonly auditService: AuditService,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(input: GerarCobrancaInput): Promise<Billing> {
    if (input.sessionIds.length === 0) {
      throw new Error('Uma cobrança deve estar vinculada a ao menos uma sessão.');
    }
    const billing = Billing.create({
      id: randomUUID(),
      tenantId: this.tenantContext.tenantId,
      patientId: input.patientId,
      amount: input.amount,
      dueDate: input.dueDate,
    });
    await this.repo.save(billing);
    await this.repo.linkSessions(billing.id, input.sessionIds); // UNIQUE(session_id) protege contra dupla-cobrança da mesma sessão

    // Módulo 10: eventos agora persistidos de verdade, não mais descartados.
    await this.auditService.recordAll(billing.pullDomainEvents());

    return billing;
  }
}

@Injectable()
export class ConsultarCobrancaUseCase {
  constructor(@Inject(BILLING_REPOSITORY) private readonly repo: BillingRepository) {}

  async execute(id: string): Promise<Billing> {
    const billing = await this.repo.findById(id);
    if (!billing) throw new NotFoundException('Cobrança não encontrada.');
    return billing;
  }
}

@Injectable()
export class ListarCobrancasUseCase {
  constructor(@Inject(BILLING_REPOSITORY) private readonly repo: BillingRepository) {}

  async execute(params?: { cursor?: string; limit?: number }): Promise<Billing[]> {
    return this.repo.findAllByTenant(params);
  }
}

/**
 * EnviarCobrancaUseCase — RF-075. Monta o template real (Padrão 7) e
 * enfileira o envio de verdade.
 *
 * DUAS DÍVIDAS FECHADAS NESTA REVISÃO GERAL:
 * 1. pixKey/payeeName agora vêm de ClinicRepository (Domain), não mais de
 *    PrismaService direto — Clinic (Módulo 06) passou a expor esses campos.
 * 2. sessionCount agora vem de BillingRepository.countLinkedSessions(),
 *    não mais fixo em 1.
 */
@Injectable()
export class EnviarCobrancaUseCase {
  constructor(
    @Inject(BILLING_REPOSITORY) private readonly repo: BillingRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patientRepo: PatientRepository,
    @Inject(CLINIC_REPOSITORY) private readonly clinicRepo: ClinicRepository,
    private readonly consultarCobranca: ConsultarCobrancaUseCase,
    private readonly messageQueue: MessageQueueProducer,
    private readonly auditService: AuditService,
  ) {}

  async execute(id: string): Promise<Billing> {
    const billing = await this.consultarCobranca.execute(id);
    const patient = await this.patientRepo.findById(billing.patientId);
    if (!patient) throw new Error('Paciente da cobrança não encontrado.');

    const clinic = await this.clinicRepo.findByTenantId(billing.tenantId);
    const sessionCount = await this.repo.countLinkedSessions(billing.id);

    const body = buildBillingMessage({
      patientFirstName: patient.name.split(' ')[0],
      sessionCount,
      amountPerSession: sessionCount > 0 ? billing.amount / sessionCount : billing.amount,
      totalAmount: billing.amount,
      pixKey: clinic?.pixKey ?? '(chave PIX não configurada)',
      payeeName: clinic?.payeeName ?? '(nome não configurado)',
    });

    await this.messageQueue.enqueue({
      tenantId: billing.tenantId,
      toPhoneNumber: patient.phone,
      body,
      idempotencyKey: `billing-${billing.id}`, // reenviar a MESMA cobrança nunca duplica mensagem
    });

    billing.transitionTo('Enviada');
    await this.repo.save(billing);

    // Módulo 10: eventos agora persistidos de verdade, não mais descartados.
    await this.auditService.recordAll(billing.pullDomainEvents());

    return billing;
  }
}
