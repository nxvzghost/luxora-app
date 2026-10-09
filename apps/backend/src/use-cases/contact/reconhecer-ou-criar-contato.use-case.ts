import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Contact } from '@domain/contact/contact.entity';
import { PhoneNumber } from '@domain/contact/phone-number.value-object';
import { ContactRepository, CONTACT_REPOSITORY } from '@domain-services/patient-ops/contact.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { UnitOfWork, UNIT_OF_WORK } from '@domain-services/platform/unit-of-work';

/**
 * ReconhecerOuCriarContatoUseCase — ADR-0055 (AD-018), Fase 4.
 *
 * Passo de resolução de identidade que roda a cada mensagem de entrada do
 * WhatsApp (Cenário 1/2 — primeiro contato e mensagens seguintes): dado um
 * telefone, encontra o Contact já existente ou cria um novo, e sempre
 * registra a interação (`interagir()`, idempotente por natureza da própria
 * entidade — ver Contact.interagir()). Só isso — nunca identifica nome
 * (Cenário 2, depende de conteúdo real da conversa, responsabilidade de
 * quem chama este Use Case) nem promove/associa a Patient (Fase 6,
 * depende de desambiguação por turno de conversa).
 *
 * É chamado duas vezes por mensagem: na entrada (ReceberMensagemWhatsApp)
 * e no processamento (ProcessarMensagemWhatsApp). Não toca em Conversation,
 * Patient nem no Inbox Pattern (ADR-0054/AD-036).
 *
 * `tenantId` é sempre recebido como parâmetro explícito, nunca lido daqui
 * de TenantContext — quem chama já precisa tê-lo resolvido (mesmo padrão
 * de ReceberMensagemWhatsAppUseCase.processInboundMessage) e é responsável
 * por já ter chamado `tenantContext.set(tenantId, null)` antes, para que
 * `ContactRepository` (Prisma, escopado por RLS) funcione.
 *
 * ADR-0063 (AD-038) — UMA MENSAGEM NÃO REGRAVA O ESTADO DE UM CONTATO QUE
 * JÁ EXISTE. Antes, toda mensagem regravava o contato inteiro com o estado
 * que tinha lido: se a clínica aprovasse um vínculo entre a leitura e a
 * gravação, a mensagem devolvia o contato ao estado anterior e a aprovação
 * se perdia, com o vínculo órfão no banco. Agora:
 *
 * - contato novo: é criado, como antes;
 * - contato que já conversa (o caso de quase toda mensagem): só a atividade
 *   é registrada (`touch`), sem regravar estado nem nome;
 * - contato existente que ainda está em `Novo`: a transição acontece com a
 *   linha travada, como toda mudança de estado de um contato existente.
 */
@Injectable()
export class ReconhecerOuCriarContatoUseCase {
  constructor(
    @Inject(CONTACT_REPOSITORY) private readonly contactRepo: ContactRepository,
    private readonly auditService: AuditService,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(tenantId: string, rawPhoneNumber: string): Promise<Contact> {
    const phoneNumber = PhoneNumber.normalize(rawPhoneNumber);

    const existing = await this.contactRepo.findByTenantAndPhone(tenantId, phoneNumber);
    if (!existing) {
      const contact = Contact.create({ id: randomUUID(), tenantId, phoneNumber });
      contact.interagir();
      await this.contactRepo.save(contact);
      // Ator não-autenticado (mensagem chegou via webhook, sem JWT) — mesmo
      // padrão já usado por ReceberMensagemWhatsAppUseCase/ProcessarMensagemWhatsAppUseCase.
      await this.auditService.recordAll(contact.pullDomainEvents(), 'system');
      return contact;
    }

    if (existing.state !== 'Novo') {
      await this.contactRepo.touch(existing.id);
      return existing;
    }

    return this.unitOfWork.run(async () => {
      const contact = await this.contactRepo.findByIdForUpdate(existing.id);
      if (!contact) {
        return existing;
      }
      contact.interagir();
      const events = contact.pullDomainEvents();
      if (events.length > 0) {
        await this.contactRepo.save(contact);
        await this.auditService.recordAll(events, 'system');
      }
      return contact;
    });
  }
}
