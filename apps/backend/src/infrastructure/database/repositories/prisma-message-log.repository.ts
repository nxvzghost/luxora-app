import { Injectable, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { MessageLogRepository } from '@domain-services/communication/message-log.repository';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

@Injectable()
export class PrismaMessageLogRepository implements MessageLogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByIdempotencyKey(key: string) {
    return this.prisma.forTenant((tx) => tx.messageLog.findUnique({ where: { idempotencyKey: key } }));
  }

  async record(entry: {
    tenantId: string;
    toPhoneNumber: string;
    body: string;
    idempotencyKey: string;
    providerMessageId: string;
  }): Promise<void> {
    try {
      await this.prisma.forTenant((tx) =>
        tx.messageLog.create({
          data: {
            tenantId: entry.tenantId,
            toPhoneNumber: entry.toPhoneNumber,
            body: entry.body,
            idempotencyKey: entry.idempotencyKey,
            providerMessageId: entry.providerMessageId,
          },
        }),
      );
    } catch (err) {
      if ((err as Prisma.PrismaClientKnownRequestError)?.code === UNIQUE_CONSTRAINT_VIOLATION) {
        throw new ConflictException({
          code: 'DUPLICATE_MESSAGE',
          message: 'Mensagem com esta idempotency key já foi enviada.',
          category: 'business_rule',
        });
      }
      throw err;
    }
  }
}
