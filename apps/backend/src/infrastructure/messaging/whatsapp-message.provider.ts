import { Injectable } from '@nestjs/common';
import { MessageProvider, SendMessageInput, SendMessageResult } from '@domain-services/communication/message-provider';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { TokenCipherService } from '@shared/token-cipher.service';

/**
 * WhatsAppMessageProvider — CORRIGIDO.
 *
 * Antes desta correção, lia WHATSAPP_PHONE_NUMBER_ID/WHATSAPP_BUSINESS_API_TOKEN
 * de variáveis de ambiente globais — toda clínica enviaria pelo mesmo
 * número. Corrigido para buscar a credencial de cada Tenant em
 * `whatsapp_integration`, preservando a identidade de cada clínica no
 * WhatsApp (diretriz explícita: "a Luxora não possui número próprio").
 *
 * Usa PrismaClientProvider diretamente (singleton, Módulo 04), não
 * PrismaService.forTenant() — a busca de credencial pode acontecer fora
 * do ciclo de requisição HTTP (worker de fila), onde o TenantContext não
 * está necessariamente populado. Consulta direta e explícita por
 * tenantId.
 *
 * NÃO TESTADO CONTRA A API REAL — sem rede neste ambiente.
 *
 * AD-005: accessToken é lido cifrado do banco e decifrado via
 * TokenCipherService antes de ser usado no header Authorization — este
 * Provider nunca sabe (nem precisa saber) qual é o formato de cifragem.
 */
@Injectable()
export class WhatsAppMessageProvider implements MessageProvider {
  private readonly apiUrl = 'https://graph.facebook.com/v19.0';

  constructor(
    private readonly prismaClient: PrismaClientProvider,
    private readonly tokenCipher: TokenCipherService,
  ) {}

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const integration = await this.prismaClient.whatsAppIntegration.findUnique({
      where: { tenantId: input.tenantId },
    });

    if (!integration || !integration.active) {
      throw new Error(
        `Clínica (tenant ${input.tenantId}) não tem WhatsApp conectado. Cada clínica precisa conectar seu próprio canal antes de enviar mensagens.`,
      );
    }

    const accessToken = this.tokenCipher.decrypt(integration.accessToken);
    const response = await fetch(`${this.apiUrl}/${integration.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        // AD-016 — permite correlacionar esta chamada externa com o restante
        // dos logs da requisição/job de origem. Ausente quando input não
        // trouxe um (nunca bloqueia o envio por isso).
        ...(input.correlationId ? { 'X-Correlation-Id': input.correlationId } : {}),
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: input.toPhoneNumber,
        type: 'text',
        text: { body: input.body },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Falha ao enviar mensagem via WhatsApp (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as { messages: Array<{ id: string }> };
    return {
      providerMessageId: data.messages[0].id,
      sentAt: new Date(),
    };
  }
}
