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
