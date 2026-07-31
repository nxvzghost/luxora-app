import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Contact } from '@domain/contact/contact.entity';
import { PhoneNumber } from '@domain/contact/phone-number.value-object';
import { ContactRepository, CONTACT_REPOSITORY } from '@domain-services/patient-ops/contact.repository';
import { AuditService } from '@domain-services/platform/audit.service';

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
 * Ainda não é chamado por nenhum fluxo real (isso é Fase 5 — Integração
 * com ReceberMensagemWhatsAppUseCase) — este Use Case é autocontido e
 * testável isoladamente, sem tocar em Conversation, Patient ou no Inbox
 * Pattern (ADR-0054/AD-036).
 *
 * `tenantId` é sempre recebido como parâmetro explícito, nunca lido daqui
 * de TenantContext — quem chama já precisa tê-lo resolvido (mesmo padrão
 * de ReceberMensagemWhatsAppUseCase.processInboundMessage) e é responsável
 * por já ter chamado `tenantContext.set(tenantId, null)` antes, para que
 * `ContactRepository` (Prisma, escopado por RLS) funcione.
 */
@Injectable()
export class ReconhecerOuCriarContatoUseCase {
  constructor(
    @Inject(CONTACT_REPOSITORY) private readonly contactRepo: ContactRepository,
    private readonly auditService: AuditService,
  ) {}

  async execute(tenantId: string, rawPhoneNumber: string): Promise<Contact> {
    const phoneNumber = PhoneNumber.normalize(rawPhoneNumber);

    let contact = await this.contactRepo.findByTenantAndPhone(tenantId, phoneNumber);
    if (!contact) {
      contact = Contact.create({ id: randomUUID(), tenantId, phoneNumber });
    }

    contact.interagir();

    await this.contactRepo.save(contact);
    // Ator não-autenticado (mensagem chegou via webhook, sem JWT) — mesmo
    // padrão já usado por ReceberMensagemWhatsAppUseCase/ProcessarMensagemWhatsAppUseCase.
    await this.auditService.recordAll(contact.pullDomainEvents(), 'system');

    return contact;
  }
}
