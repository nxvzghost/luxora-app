import { Injectable } from '@nestjs/common';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { TenantContext } from '@shared/tenant-context';

export interface ConectarWhatsAppInput {
  phoneNumberId: string;
  accessToken: string;
}

/**
 * ConectarWhatsAppUseCase — cada clínica conecta seu próprio canal.
 *
 * Sem este Caso de Uso, a tabela whatsapp_integration (criada na correção
 * de isolamento) nunca teria como ser populada.
 */
@Injectable()
export class ConectarWhatsAppUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(input: ConectarWhatsAppInput): Promise<void> {
    await this.prisma.forTenant((tx) =>
      tx.whatsAppIntegration.upsert({
        where: { tenantId: this.tenantContext.tenantId },
        create: {
          tenantId: this.tenantContext.tenantId,
          phoneNumberId: input.phoneNumberId,
          accessToken: input.accessToken,
        },
        update: {
          phoneNumberId: input.phoneNumberId,
          accessToken: input.accessToken,
          active: true,
        },
      }),
    );
  }
}
