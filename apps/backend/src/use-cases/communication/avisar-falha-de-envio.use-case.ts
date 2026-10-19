import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Notification } from '@domain/notification/notification.entity';
import { NotificationRepository, NOTIFICATION_REPOSITORY } from '@domain-services/platform/notification.repository';
import { MessageLogRepository, MESSAGE_LOG_REPOSITORY } from '@domain-services/communication/message-log.repository';
import { logReference } from '@shared/logging/log-reference';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OVERDUE_REMINDER_KEY = new RegExp(`^billing-overdue-(${UUID})-d\\d+$`, 'i');
const BILLING_KEY = new RegExp(`^billing-(${UUID})$`, 'i');
/** Reenvio pelo painel (ReenviarCobrancaUseCase): `billing-<cobrança>-resend-<aviso>`. */
const BILLING_RESEND_KEY = new RegExp(`^billing-(${UUID})-resend-`, 'i');
const AGENDA_SUMMARY_KEY = new RegExp(`^agenda-summary(?:-updated)?-(${UUID})-`, 'i');

export interface MessagePurpose {
  /** Começo da frase do aviso, com artigo: "A cobrança", "O resumo da agenda"… */
  label: string;
  feminine: boolean;
  /** A que o aviso se refere. Também é a chave que impede avisos repetidos enquanto o anterior não é lido. */
  entityType: string;
  entityId: string;
  /** Frase extra, quando o painel mostra algo que a clínica precisa saber. */
  note?: string;
}

/**
 * Do que se trata a mensagem, lido da chave de idempotência que cada caso de
 * uso já monta ao enfileirar. Chave desconhecida vira "A mensagem", nunca um erro.
 * Para o que não é cadastro (respostas automáticas), a referência é opaca:
 * a chave carrega o wamid, que embute o telefone (A-18).
 */
export function describeMessagePurpose(idempotencyKey: string): MessagePurpose {
  const reminder = OVERDUE_REMINDER_KEY.exec(idempotencyKey);
  if (reminder) {
    return { label: 'O lembrete de cobrança em atraso', feminine: false, entityType: 'Billing', entityId: reminder[1] };
  }
  const billing = BILLING_KEY.exec(idempotencyKey) ?? BILLING_RESEND_KEY.exec(idempotencyKey);
  if (billing) {
    return {
      label: 'A cobrança',
      feminine: true,
      entityType: 'Billing',
      entityId: billing[1],
      note: 'No painel ela continua como Enviada.',
    };
  }
  const agenda = AGENDA_SUMMARY_KEY.exec(idempotencyKey);
  if (agenda) {
    return { label: 'O resumo da agenda', feminine: false, entityType: 'Therapist', entityId: agenda[1] };
  }
  const opaque = { entityType: 'WhatsAppMessage', entityId: logReference(idempotencyKey) };
  if (idempotencyKey.startsWith('conversation-reply-')) {
    return { label: 'A resposta automática da conversa', feminine: true, ...opaque };
  }
  if (idempotencyKey.startsWith('unsupported-media-reply-')) {
    return { label: 'A resposta automática a uma mensagem que não é texto', feminine: true, ...opaque };
  }
  return { label: 'A mensagem', feminine: true, ...opaque };
}

/** Códigos de erro da Meta que aparecem no envio ou no status de entrega, em linguagem da clínica. */
const META_ERRORS: Record<number, string> = {
  131047:
    'a pessoa não escreve à clínica há mais de 24 horas, e fora dessa janela o WhatsApp só entrega mensagem de modelo aprovado',
  131026: 'o número não pôde receber a mensagem (pode não ter WhatsApp ou ter bloqueado a clínica)',
  131021: 'o número de destino é o próprio número da clínica',
  131051: 'o WhatsApp não aceita esse tipo de mensagem',
  131049: 'o WhatsApp segurou a mensagem para não sobrecarregar a pessoa com mensagens de empresas',
  131056: 'foram muitas mensagens para o mesmo número em pouco tempo',
};

/** Motivo de uma falha definitiva da fila de saída, a partir da mensagem de erro já sanitizada do provider. */
export function describeSendFailure(reason: string): string {
  if (/não tem WhatsApp conectado/.test(reason)) {
    return 'o WhatsApp da clínica não está conectado. Conecte em Configurações';
  }
  if (/não pôde ser decifrada|\(401\)|code=190\b/.test(reason)) {
    return 'a credencial do WhatsApp da clínica foi recusada. Reconecte o WhatsApp em Configurações';
  }
  const code = Number(/code=(\d+)/.exec(reason)?.[1]);
  if (META_ERRORS[code]) return META_ERRORS[code];
  if (/\((429|5\d\d)\)|tempo limite|falha de rede/.test(reason)) {
    return 'o WhatsApp não respondeu, ou recusou por excesso de envios, nas 3 tentativas';
  }
  return 'o WhatsApp recusou o envio';
}

/** Motivo de um status `failed` da Meta (a mensagem foi aceita, mas não chegou). */
export function describeDeliveryFailure(code?: number): string {
  if (code && META_ERRORS[code]) return META_ERRORS[code];
  return code ? `o WhatsApp não entregou a mensagem (código ${code})` : 'o WhatsApp não entregou a mensagem';
}

function phoneTail(phone: string): string {
  return phone.replace(/\D/g, '').slice(-4) || '----';
}

const NOT_SENT = { type: 'whatsapp_send_failed', title: 'WhatsApp: mensagem não enviada' };
const NOT_DELIVERED = { type: 'whatsapp_delivery_failed', title: 'WhatsApp: mensagem não entregue' };

/**
 * AvisarFalhaDeEnvioUseCase — A-08 da auditoria (19/10/2026).
 *
 * Até aqui, uma mensagem que não saía (credencial recusada, WhatsApp
 * desconectado, 3 tentativas esgotadas) só deixava um aviso no log do
 * servidor, e um status `failed` da Meta (mensagem aceita, mas não
 * entregue — o caso típico é a janela de 24 horas, A-07) era ignorado. A
 * clínica acreditava ter cobrado. Agora as duas situações viram um aviso no
 * painel, pelas notificações que já existem.
 *
 * O aviso traz do que se tratava a mensagem, o final do número e o motivo —
 * nunca o texto da mensagem nem dado de paciente. Um aviso por assunto
 * (a cobrança, ou a mensagem) enquanto o anterior não for lido.
 *
 * Decisão registrada: o estado da cobrança NÃO muda. "Enviada" continua
 * "Enviada"; o aviso diz isso. Dar à cobrança um estado próprio de falha de
 * envio é decisão de produto ainda aberta.
 */
@Injectable()
export class AvisarFalhaDeEnvioUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notificationRepo: NotificationRepository,
    @Inject(MESSAGE_LOG_REPOSITORY) private readonly logRepo: MessageLogRepository,
  ) {}

  /** A fila de saída desistiu do envio (falha definitiva). */
  async naoEnviada(input: { tenantId: string; toPhoneNumber: string; idempotencyKey: string; reason: string }): Promise<void> {
    const purpose = describeMessagePurpose(input.idempotencyKey);
    const verb = purpose.feminine ? 'enviada' : 'enviado';
    await this.notify(
      input.tenantId,
      NOT_SENT,
      purpose,
      `${purpose.label} para o número com final ${phoneTail(input.toPhoneNumber)} não foi ${verb}: ${describeSendFailure(input.reason)}.`,
    );
  }

  /**
   * A Meta mandou status `failed` para uma mensagem que ela tinha aceitado.
   * Devolve false quando o envio não é desta clínica ou não está registrado
   * (nada a fazer). Status repetido da mesma mensagem não gera novo aviso.
   */
  async naoEntregue(input: { tenantId: string; providerMessageId: string; errorCode?: number }): Promise<boolean> {
    if (!input.providerMessageId) return false;
    const log = await this.logRepo.findByProviderMessageId(input.providerMessageId);
    if (!log) return false;
    if (log.status === 'failed') return true;

    await this.logRepo.markFailed(log.id);
    const purpose = describeMessagePurpose(log.idempotencyKey);
    const verb = purpose.feminine ? 'aceita' : 'aceito';
    await this.notify(
      input.tenantId,
      NOT_DELIVERED,
      purpose,
      `${purpose.label} para o número com final ${phoneTail(log.toPhoneNumber)} foi ${verb} pelo WhatsApp, mas não chegou: ${describeDeliveryFailure(input.errorCode)}.`,
    );
    return true;
  }

  private async notify(
    tenantId: string,
    kind: { type: string; title: string },
    purpose: MessagePurpose,
    sentence: string,
  ): Promise<void> {
    if (await this.notificationRepo.hasUnread(kind.type, purpose.entityId)) return;
    await this.notificationRepo.create(
      Notification.create({
        id: randomUUID(),
        tenantId,
        type: kind.type,
        title: kind.title,
        message: purpose.note ? `${sentence} ${purpose.note}` : sentence,
        entityType: purpose.entityType,
        entityId: purpose.entityId,
      }),
    );
  }
}
