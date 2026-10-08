import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Billing } from '@domain/billing/billing.entity';
import { BillingRepository, BILLING_REPOSITORY } from '@domain-services/financial/billing.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { TenantContext } from '@shared/tenant-context';
import { PatientRepository, PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { ClinicRepository, CLINIC_REPOSITORY } from '@domain-services/platform/clinic.repository';
import { SessionRepository, SESSION_REPOSITORY } from '@domain-services/patient-ops/session.repository';
import { DomainEvent } from '@domain/shared/domain-event';
import { MessageQueueProducer } from '@infrastructure/messaging/message-queue.producer';
import {
  MessageChannelNotConnectedError,
  MessageChannelStatus,
  MESSAGE_CHANNEL_STATUS,
} from '@domain-services/communication/message-channel-status';
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
 *
 * AD-009 (ADR-0052): logo após linkSessions(), cada Session vinculada
 * transiciona Realizada → Faturada, na mesma execução — nunca em
 * EnviarCobrancaUseCase. Decisão registrada na ADR: Billing já suporta
 * Criada → Quitada direto (pagamento antes de qualquer envio), e disparar
 * Faturada só no envio deixaria esse caminho pular Faturada, o que a própria
 * máquina de estados de Session rejeita (Realizada só vai para Faturada).
 */
@Injectable()
export class GerarCobrancaUseCase {
  constructor(
    @Inject(BILLING_REPOSITORY) private readonly repo: BillingRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessionRepo: SessionRepository,
    private readonly auditService: AuditService,
    private readonly tenantContext: TenantContext,
    @Inject(PATIENT_REPOSITORY) private readonly patientRepo: PatientRepository,
  ) {}

  async execute(input: GerarCobrancaInput): Promise<Billing> {
    if (input.sessionIds.length === 0) {
      throw new Error('Uma cobrança deve estar vinculada a ao menos uma sessão.');
    }
    // Tarefa 06 (AD-032) — ACHADO REAL: o paciente não era conferido, e a
    // chave estrangeira não olha a clínica. A leitura passa pela RLS.
    if (!(await this.patientRepo.findById(input.patientId))) {
      throw new NotFoundException('Paciente não encontrado.');
    }
    // Tarefa 06 — ACHADO REAL: as sessões só eram lidas DEPOIS de a cobrança
    // e o vínculo já estarem gravados. Com o id de uma sessão de outra
    // clínica, a resposta era 404, mas o vínculo ficava — e, como cada sessão
    // só pode ter uma cobrança, a outra clínica não conseguia mais cobrá-la.
    // Agora todas são lidas antes (pela RLS); sessão alheia ou inexistente
    // recusa o pedido sem gravar nada.
    const sessions = [];
    for (const sessionId of input.sessionIds) {
      const session = await this.sessionRepo.findById(sessionId);
      if (!session) {
        throw new NotFoundException(`Sessão ${sessionId} não encontrada.`);
      }
      sessions.push(session);
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

    const sessionEvents: DomainEvent[] = [];
    for (const session of sessions) {
      session.transitionTo('Faturada');
      await this.sessionRepo.save(session);
      sessionEvents.push(...session.pullDomainEvents());
    }

    // Módulo 10: eventos agora persistidos de verdade, não mais descartados.
    // AD-009: eventos da Billing e das Sessions vinculadas mesclados num
    // único recordAll(), mesmo precedente já usado em ConfirmarConsultaUseCase.
    await this.auditService.recordAll([...billing.pullDomainEvents(), ...sessionEvents]);

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
 *
 * Tarefa 05 da auditoria — ACHADO REAL: sem WhatsApp conectado, a cobrança
 * era marcada como Enviada e o envio só falhava depois, no worker da fila,
 * em definitivo e sem aviso. Como Enviada não volta para Criada, a cobrança
 * nunca mais podia ser enviada. Agora a falta do canal é recusada antes de
 * enfileirar (WHATSAPP_NOT_CONNECTED) e a cobrança continua em Criada.
 * Falhas que só o provider conhece (token recusado, por exemplo) continuam
 * acontecendo depois do enfileiramento.
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
    @Inject(MESSAGE_CHANNEL_STATUS) private readonly messageChannel: MessageChannelStatus,
  ) {}

  async execute(id: string): Promise<Billing> {
    const billing = await this.consultarCobranca.execute(id);
    if (!(await this.messageChannel.isConnected())) {
      throw new MessageChannelNotConnectedError();
    }
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
