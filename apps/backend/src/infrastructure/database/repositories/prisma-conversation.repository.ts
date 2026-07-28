import { Injectable } from '@nestjs/common';
import { Conversation as PrismaConversation, Message as PrismaMessage, Prisma } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { Conversation, Message, MessageDirection } from '@domain/communication/conversation.entity';
import { ConversationRepository } from '@domain-services/communication/conversation.repository';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

@Injectable()
export class PrismaConversationRepository implements ConversationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByTenantAndPhone(tenantId: string, phoneNumber: string): Promise<Conversation | null> {
    const record = await this.prisma.forTenant((tx) =>
      tx.conversation.findUnique({ where: { tenantId_phoneNumber: { tenantId, phoneNumber } } }),
    );
    return record ? this.toDomain(record) : null;
  }

  async findById(id: string): Promise<Conversation | null> {
    const record = await this.prisma.forTenant((tx) => tx.conversation.findUnique({ where: { id } }));
    return record ? this.toDomain(record) : null;
  }

  async save(conversation: Conversation): Promise<void> {
    await this.prisma.forTenant((tx) =>
      tx.conversation.upsert({
        where: { id: conversation.id },
        create: {
          id: conversation.id,
          tenantId: conversation.tenantId,
          phoneNumber: conversation.phoneNumber,
          patientId: conversation.patientId,
        },
        update: {
          patientId: conversation.patientId,
        },
      }),
    );
  }

  async appendMessages(messages: Message[], tenantId: string): Promise<void> {
    if (messages.length === 0) return;
    try {
      await this.prisma.forTenant((tx) =>
        tx.message.createMany({
          data: messages.map((m) => ({
            id: m.id,
            tenantId,
            conversationId: m.conversationId,
            direction: m.direction as PrismaMessage['direction'],
            content: m.content,
            externalId: m.externalId,
            status: m.status,
          })),
        }),
      );
    } catch (err) {
      // ADR-0053 §6 — reentrega do mesmo WAMID pela Meta é inofensiva por
      // construção: a violação de @unique(external_id) é o próprio
      // mecanismo de idempotência funcionando, nunca um erro real.
      if ((err as Prisma.PrismaClientKnownRequestError)?.code === UNIQUE_CONSTRAINT_VIOLATION) {
        return;
      }
      throw err;
    }
  }

  async findMessageByExternalId(externalId: string): Promise<Message | null> {
    const record = await this.prisma.forTenant((tx) => tx.message.findUnique({ where: { externalId } }));
    return record ? this.messageToDomain(record) : null;
  }

  async findMessagesByConversationId(conversationId: string): Promise<Message[]> {
    const records = await this.prisma.forTenant((tx) =>
      tx.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } }),
    );
    return records.map((r) => this.messageToDomain(r));
  }

  private toDomain(record: PrismaConversation): Conversation {
    return Conversation.reconstitute({
      id: record.id,
      tenantId: record.tenantId,
      phoneNumber: record.phoneNumber,
      patientId: record.patientId,
      createdAt: record.createdAt,
    });
  }

  private messageToDomain(record: PrismaMessage): Message {
    return Message.reconstitute({
      id: record.id,
      conversationId: record.conversationId,
      tenantId: record.tenantId,
      direction: record.direction as MessageDirection,
      content: record.content,
      externalId: record.externalId,
      status: record.status,
      createdAt: record.createdAt,
    });
  }
}
