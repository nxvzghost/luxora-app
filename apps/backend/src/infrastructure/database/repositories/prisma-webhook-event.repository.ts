import { Injectable } from '@nestjs/common';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { WebhookEventRepository } from '@domain-services/subscription/webhook-event.repository';

@Injectable()
export class PrismaWebhookEventRepository implements WebhookEventRepository {
  constructor(private readonly prismaClient: PrismaClientProvider) {}

  async wasProcessed(asaasEventId: string): Promise<boolean> {
    const existing = await this.prismaClient.asaasWebhookEvent.findUnique({ where: { asaasEventId } });
    return existing !== null;
  }

  async markProcessed(asaasEventId: string, eventType: string): Promise<void> {
    await this.prismaClient.asaasWebhookEvent.create({
      data: { asaasEventId, eventType },
    });
  }
}
