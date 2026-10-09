import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Notification } from '@domain/notification/notification.entity';
import { ContactRepository, CONTACT_REPOSITORY } from '@domain-services/patient-ops/contact.repository';
import { NotificationRepository, NOTIFICATION_REPOSITORY } from '@domain-services/platform/notification.repository';

/**
 * Por que a conversa foi entregue à clínica (ADR-0063):
 * - `shared_number`: o número consta no cadastro de mais de um paciente;
 * - `link_request`: um número novo diz ser de (ou tratar de) um paciente que já existe;
 * - `possible_duplicate`: pediu cadastro com um nome que já existe entre os pacientes;
 * - `human_review`: o pedido depende de saber para quem é, e o sistema não decide isso sozinho.
 */
export type HumanHandoffReason = 'shared_number' | 'link_request' | 'possible_duplicate' | 'human_review';

export interface SolicitarAtendimentoHumanoInput {
  tenantId: string;
  contactId: string;
  reason: HumanHandoffReason;
}

const NOTICES: Record<HumanHandoffReason, { type: string; title: string; message: (tail: string) => string }> = {
  shared_number: {
    type: 'whatsapp_shared_number',
    title: 'WhatsApp: número de mais de um paciente',
    message: (tail) =>
      `O número com final ${tail} consta no cadastro de mais de um paciente. O atendimento automático desse número está suspenso: nada é agendado, cancelado ou cobrado por ele. A conversa precisa de atendimento humano.`,
  },
  link_request: {
    type: 'whatsapp_link_request',
    title: 'WhatsApp: número novo aguardando vínculo',
    message: (tail) =>
      `O número com final ${tail} informou já ser de um paciente da clínica. Nada foi vinculado nem informado a essa pessoa. Confira a identidade por outro meio e, se for o caso, aprove o vínculo em Pacientes.`,
  },
  possible_duplicate: {
    type: 'whatsapp_possible_duplicate',
    title: 'WhatsApp: possível cadastro duplicado',
    message: (tail) =>
      `O número com final ${tail} pediu cadastro com um nome que já existe entre os pacientes da clínica. Nenhum cadastro novo foi criado. Se for o mesmo paciente em um número novo, aprove o vínculo em Pacientes; se for outra pessoa, cadastre-a pelo painel.`,
  },
  human_review: {
    type: 'whatsapp_human_review',
    title: 'WhatsApp: conversa aguardando atendimento humano',
    message: (tail) =>
      `A conversa com o número de final ${tail} foi encaminhada para a equipe: o pedido depende de confirmar para quem é o atendimento, e nada foi feito automaticamente.`,
  },
};

/**
 * SolicitarAtendimentoHumanoUseCase — ADR-0063 (AD-038). Entrega à clínica
 * uma conversa que o sistema não pode resolver sozinho, pelo recurso que já
 * existe: as notificações internas do painel.
 *
 * O aviso é para a equipe, não para quem escreve. Traz só o final do número
 * — o suficiente para a equipe achar a conversa — e nenhum dado de paciente.
 *
 * Um aviso por contato e por motivo enquanto o anterior não for lido: uma
 * conversa que continua esperando não gera um aviso a cada mensagem.
 */
@Injectable()
export class SolicitarAtendimentoHumanoUseCase {
  constructor(
    @Inject(CONTACT_REPOSITORY) private readonly contactRepo: ContactRepository,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notificationRepo: NotificationRepository,
  ) {}

  async execute(input: SolicitarAtendimentoHumanoInput): Promise<void> {
    const notice = NOTICES[input.reason];
    if (await this.notificationRepo.hasUnread(notice.type, input.contactId)) {
      return;
    }

    const contact = await this.contactRepo.findById(input.contactId);
    const tail = contact?.phoneNumber?.toE164().slice(-4) ?? '----';

    await this.notificationRepo.create(
      Notification.create({
        id: randomUUID(),
        tenantId: input.tenantId,
        type: notice.type,
        title: notice.title,
        message: notice.message(tail),
        entityType: 'Contact',
        entityId: input.contactId,
      }),
    );
  }
}
