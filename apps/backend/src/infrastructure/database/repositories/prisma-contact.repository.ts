import { Injectable } from '@nestjs/common';
import { Contact as PrismaContact, ContactPatientAssociation as PrismaAssociation, Prisma } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import {
  Contact,
  ContactPatientAssociation,
  ContactPatientRole,
  ContactState,
} from '@domain/contact/contact.entity';
import { PhoneNumber } from '@domain/contact/phone-number.value-object';
import { ContactRepository } from '@domain-services/patient-ops/contact.repository';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

@Injectable()
export class PrismaContactRepository implements ContactRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByTenantAndPhone(tenantId: string, phoneNumber: PhoneNumber): Promise<Contact | null> {
    const record = await this.prisma.forTenant((tx) =>
      tx.contact.findUnique({
        where: { tenantId_phoneNumber: { tenantId, phoneNumber: phoneNumber.toE164() } },
      }),
    );
    return record ? this.toDomain(record) : null;
  }

  async findById(id: string): Promise<Contact | null> {
    const record = await this.prisma.forTenant((tx) => tx.contact.findUnique({ where: { id } }));
    return record ? this.toDomain(record) : null;
  }

  async save(contact: Contact): Promise<void> {
    // contact.phoneNumber só é nulo depois de anonimizar() — nenhuma
    // suposição de não-nulo em nenhum ponto deste mapeamento.
    const phoneNumber = contact.phoneNumber?.toE164() ?? null;

    try {
      await this.prisma.forTenant((tx) =>
        tx.contact.upsert({
          where: { id: contact.id },
          create: {
            id: contact.id,
            tenantId: contact.tenantId,
            phoneNumber,
            name: contact.name,
            state: contact.state,
          },
          update: {
            phoneNumber,
            name: contact.name,
            state: contact.state,
          },
        }),
      );
    } catch (err) {
      // ACHADO REAL (Fase 8.0, discovery de hardening) — duas mensagens
      // quase simultâneas do MESMO telefone, nunca visto antes, geram dois
      // ids novos distintos em ReconhecerOuCriarContatoUseCase.execute()
      // (cada chamada gera seu próprio randomUUID()). As duas tentam o
      // ramo create() deste upsert (nenhum dos dois ids existe ainda) — a
      // segunda viola @@unique([tenantId, phoneNumber]), uma constraint
      // diferente da usada no `where` (chaveado por id), então o Prisma
      // nunca resolve isso como update. Mesmo idioma já usado em
      // saveAssociation(): a constraint única É o próprio mecanismo de
      // não-duplicidade funcionando — nunca um erro real nesta corrida,
      // já que as duas chamadas computam exatamente a mesma transição
      // (Novo→Conversando) a partir da mesma premissa (nenhum Contact
      // existia ainda para este telefone).
      if ((err as Prisma.PrismaClientKnownRequestError)?.code === UNIQUE_CONSTRAINT_VIOLATION) {
        return;
      }
      throw err;
    }
  }

  async saveAssociation(association: ContactPatientAssociation): Promise<void> {
    try {
      await this.prisma.forTenant((tx) =>
        tx.contactPatientAssociation.create({
          data: {
            id: association.id,
            tenantId: association.tenantId,
            contactId: association.contactId,
            patientId: association.patientId,
            role: association.role,
          },
        }),
      );
    } catch (err) {
      // Mesmo idioma já usado em PrismaConversationRepository.appendMessages()
      // — a constraint única (contactId, patientId) é o próprio mecanismo de
      // não-duplicidade funcionando (ver Contact.associarAPaciente()), nunca
      // um erro real numa reentrega.
      if ((err as Prisma.PrismaClientKnownRequestError)?.code === UNIQUE_CONSTRAINT_VIOLATION) {
        return;
      }
      throw err;
    }
  }

  async findAssociationsByContactId(contactId: string): Promise<ContactPatientAssociation[]> {
    const records = await this.prisma.forTenant((tx) => tx.contactPatientAssociation.findMany({ where: { contactId } }));
    return records.map((r) => this.associationToDomain(r));
  }

  /**
   * ADR-0063 (AD-038) — lê o Contact travando a linha (`SELECT ... FOR
   * UPDATE`) até o fim da unidade de trabalho. Duas operações sobre o mesmo
   * contato passam a acontecer uma depois da outra: a segunda espera a
   * primeira confirmar e então lê o estado já atualizado. Mesmo recurso de
   * PrismaUserRepository.provisionFirstAdmin(), sem migration e sem mudar o
   * nível de isolamento.
   *
   * A trava só dura enquanto a transação durar; fora de uma unidade de
   * trabalho ela seria solta no fim desta própria chamada e não protegeria
   * nada — por isso o uso fora de uma é recusado.
   *
   * A RLS vale também aqui: o contato de outra clínica não é devolvido nem
   * travado, e quem o pede não fica esperando por ele.
   *
   * "id" é TEXT no Postgres (ver a nota em provisionFirstAdmin) — sem cast.
   */
  async findByIdForUpdate(id: string): Promise<Contact | null> {
    if (!this.prisma.isInUnitOfWork) {
      throw new Error('findByIdForUpdate() só pode ser chamado dentro de uma unidade de trabalho.');
    }

    const record = await this.prisma.forTenant(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "contact" WHERE id = ${id} FOR UPDATE`;
      if (locked.length === 0) return null;
      return tx.contact.findUnique({ where: { id } });
    });
    return record ? this.toDomain(record) : null;
  }

  /**
   * ADR-0063 (AD-038) — registra que o contato teve atividade, e só isso:
   * grava `updated_at` e não toca em estado nem em nome. Uma mensagem que
   * chega enquanto a clínica aprova um vínculo não pode regravar o estado
   * que leu antes da aprovação.
   */
  async touch(id: string): Promise<void> {
    await this.prisma.forTenant((tx) => tx.contact.updateMany({ where: { id }, data: { updatedAt: new Date() } }));
  }

  // ADR-0063 (AD-038) — a RLS limita a busca à clínica, como em qualquer
  // outra leitura. Um Contact anonimizado (sem telefone) não entra.
  async findUnlinked(limit: number): Promise<Contact[]> {
    const records = await this.prisma.forTenant((tx) =>
      tx.contact.findMany({
        where: {
          state: { in: ['Conversando', 'Identificado'] },
          phoneNumber: { not: null },
          associations: { none: {} },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take: limit,
      }),
    );
    return records.map((r) => this.toDomain(r));
  }

  private toDomain(record: PrismaContact): Contact {
    return Contact.reconstitute({
      id: record.id,
      tenantId: record.tenantId,
      phoneNumber: record.phoneNumber ? PhoneNumber.fromE164(record.phoneNumber) : null,
      name: record.name,
      state: record.state as ContactState,
      createdAt: record.createdAt,
    });
  }

  private associationToDomain(record: PrismaAssociation): ContactPatientAssociation {
    return ContactPatientAssociation.reconstitute({
      id: record.id,
      tenantId: record.tenantId,
      contactId: record.contactId,
      patientId: record.patientId,
      role: record.role as ContactPatientRole,
      createdAt: record.createdAt,
    });
  }
}
