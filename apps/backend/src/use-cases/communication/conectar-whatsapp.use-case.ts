import { Injectable } from '@nestjs/common';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { TenantContext } from '@shared/tenant-context';
import { TokenCipherService } from '@shared/token-cipher.service';

export interface ConectarWhatsAppInput {
  phoneNumberId: string;
  accessToken: string;
}

/**
 * ConectarWhatsAppUseCase — cada clínica conecta seu próprio canal.
 *
 * Sem este Caso de Uso, a tabela whatsapp_integration (criada na correção
 * de isolamento) nunca teria como ser populada.
 *
 * AD-005: accessToken é cifrado em repouso via TokenCipherService antes de
 * gravar — nunca grava o texto puro recebido do admin.
 */
@Injectable()
export class ConectarWhatsAppUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContext,
    private readonly tokenCipher: TokenCipherService,
  ) {}

  async execute(input: ConectarWhatsAppInput): Promise<void> {
    const encryptedAccessToken = this.tokenCipher.encrypt(input.accessToken);
    await this.prisma.forTenant((tx) =>
      tx.whatsAppIntegration.upsert({
        where: { tenantId: this.tenantContext.tenantId },
        create: {
          tenantId: this.tenantContext.tenantId,
          phoneNumberId: input.phoneNumberId,
          accessToken: encryptedAccessToken,
        },
        update: {
          phoneNumberId: input.phoneNumberId,
          accessToken: encryptedAccessToken,
          active: true,
        },
      }),
    );
  }
}
