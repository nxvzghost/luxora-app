import { Injectable, Inject, NotFoundException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Billing, BillingState } from '@domain/billing/billing.entity';
import { NotificationRepository, NOTIFICATION_REPOSITORY } from '@domain-services/platform/notification.repository';
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

/** Destinatário e texto da mensagem de cobrança — os mesmos no envio e no reenvio. */
async function composeBillingMessage(
  billing: Billing,
  repo: BillingRepository,
  patientRepo: PatientRepository,
  clinicRepo: ClinicRepository,
): Promise<{ toPhoneNumber: string; body: string }> {
  const patient = await patientRepo.findById(billing.patientId);
  if (!patient) throw new Error('Paciente da cobrança não encontrado.');

  const clinic = await clinicRepo.findByTenantId(billing.tenantId);
  const sessionCount = await repo.countLinkedSessions(billing.id);

  const body = buildBillingMessage({
    patientFirstName: patient.name.split(' ')[0],
    sessionCount,
    amountPerSession: sessionCount > 0 ? billing.amount / sessionCount : billing.amount,
    totalAmount: billing.amount,
    pixKey: clinic?.pixKey ?? '(chave PIX não configurada)',
    payeeName: clinic?.payeeName ?? '(nome não configurado)',
  });
  return { toPhoneNumber: patient.phone, body };
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
    const { toPhoneNumber, body } = await composeBillingMessage(billing, this.repo, this.patientRepo, this.clinicRepo);

    await this.messageQueue.enqueue({
      tenantId: billing.tenantId,
      toPhoneNumber,
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

/** Estados em que a cobrança já foi enviada e ainda espera pagamento: os únicos em que reenviar faz sentido. */
const RESENDABLE_STATES: readonly BillingState[] = ['Enviada', 'Visualizada', 'Pendente'];
/** Avisos de falha que a A-08 cria para uma cobrança (AvisarFalhaDeEnvioUseCase). */
export const BILLING_FAILURE_NOTICE_TYPES = ['whatsapp_send_failed', 'whatsapp_delivery_failed'] as const;

/** Registro de auditoria do reenvio: qual cobrança, a partir de qual aviso. Ator: o usuário da requisição. */
export class BillingMessageResentEvent extends DomainEvent {
  declare readonly failureNoticeId: string;

  constructor(billingId: string, tenantId: string, failureNoticeId: string) {
    super('CobrancaReenviada', billingId, tenantId, { failureNoticeId });
  }
}

/**
 * ReenviarCobrancaUseCase — reenvio pelo painel, depois de um aviso de falha
 * (19/10/2026, decisão do responsável pelo produto, ADR-0066).
 *
 * Até aqui não havia como reenviar: `Enviada → Enviada` não existe, e a fila
 * ignora um job novo com o id de um que ela ainda guarda (os falhos ficam 14
 * dias). Regras:
 *
 * - só uma cobrança já enviada e ainda não paga (`Enviada`, `Visualizada`,
 *   `Pendente`); o estado não muda;
 * - só com um aviso de falha de envio ou de entrega desta cobrança ainda não
 *   lido. Reenviar dá os avisos por tratados (lidos): o botão some até uma
 *   nova falha, e não serve para mandar a cobrança várias vezes;
 * - a chave do envio é derivada do aviso mais recente
 *   (`billing-<id>-resend-<aviso>`): clique duplo, ou a mesma requisição
 *   repetida, não manda duas vezes;
 * - o reenvio fica na auditoria (`CobrancaReenviada`), com quem reenviou.
 *
 * Se o motivo da falha não foi corrigido (credencial, canal, janela de 24
 * horas), o reenvio falha de novo e um aviso novo aparece.
 */
@Injectable()
export class ReenviarCobrancaUseCase {
  constructor(
    @Inject(BILLING_REPOSITORY) private readonly repo: BillingRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patientRepo: PatientRepository,
    @Inject(CLINIC_REPOSITORY) private readonly clinicRepo: ClinicRepository,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notificationRepo: NotificationRepository,
    private readonly consultarCobranca: ConsultarCobrancaUseCase,
    private readonly messageQueue: MessageQueueProducer,
    private readonly auditService: AuditService,
    @Inject(MESSAGE_CHANNEL_STATUS) private readonly messageChannel: MessageChannelStatus,
  ) {}

  async execute(id: string): Promise<Billing> {
    const billing = await this.consultarCobranca.execute(id);
    if (!RESENDABLE_STATES.includes(billing.state)) {
      throw new ConflictException('Só uma cobrança já enviada e ainda não paga pode ser reenviada.');
    }
    if (!(await this.messageChannel.isConnected())) {
      throw new MessageChannelNotConnectedError();
    }
    const notices = await this.notificationRepo.findUnreadByEntity(billing.id, BILLING_FAILURE_NOTICE_TYPES);
    if (notices.length === 0) {
      throw new ConflictException('Esta cobrança não tem aviso de falha de envio em aberto: não há o que reenviar.');
    }
    const [latest] = notices;

    const { toPhoneNumber, body } = await composeBillingMessage(billing, this.repo, this.patientRepo, this.clinicRepo);
    await this.messageQueue.enqueue({
      tenantId: billing.tenantId,
      toPhoneNumber,
      body,
      idempotencyKey: `billing-${billing.id}-resend-${latest.id}`,
    });

    for (const notice of notices) {
      await this.notificationRepo.markAsRead(notice.id);
    }
    await this.auditService.recordAll([new BillingMessageResentEvent(billing.id, billing.tenantId, latest.id)]);

    return billing;
  }
}
