import { Injectable } from '@nestjs/common';
import { MessageChannelStatus } from '@domain-services/communication/message-channel-status';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { TenantContext } from '@shared/tenant-context';

/**
 * WhatsAppChannelStatus — mesma condição que WhatsAppMessageProvider aplica
 * na hora de enviar (integração existente e ativa), consultada antes de
 * enfileirar. Nenhuma chamada externa.
 */
@Injectable()
export class WhatsAppChannelStatus implements MessageChannelStatus {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContext,
  ) {}

  async isConnected(): Promise<boolean> {
    const integration = await this.prisma.forTenant((tx) =>
      tx.whatsAppIntegration.findUnique({ where: { tenantId: this.tenantContext.tenantId }, select: { active: true } }),
    );
    return integration?.active === true;
  }
}
