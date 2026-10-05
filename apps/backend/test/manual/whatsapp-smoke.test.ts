import { describe, it, expect } from 'vitest';
import { WhatsAppMessageProvider } from '@infrastructure/messaging/whatsapp-message.provider';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { TokenCipherService } from '@shared/token-cipher.service';
import { loadBackendEnv, logSmoke } from './support/smoke-env';

/**
 * [MANUAL / EXTERNAL] Envio real pela Graph API da Meta — UMA mensagem de texto, pelo
 * WhatsAppMessageProvider real, para um destinatário controlado.
 *
 * Só roda com as três variáveis abaixo definidas; sem elas o arquivo
 * inteiro é pulado. Ver test/manual/README.md.
 *
 *   WHATSAPP_SMOKE_PHONE_NUMBER_ID  id do NÚMERO DE TESTE do App da Meta
 *   WHATSAPP_SMOKE_ACCESS_TOKEN     token temporário desse App
 *   WHATSAPP_SMOKE_TO               destinatário autorizado no painel do
 *                                   App (o seu próprio número) — nunca um
 *                                   paciente
 *
 * Nenhum banco é usado: a integração da "clínica" é um objeto em memória,
 * com o token cifrado pelo TokenCipherService real — o caminho
 * cifra → decifra → header Authorization é o mesmo da aplicação.
 *
 * Fora da janela de 24 h de conversa a Meta só entrega mensagens de
 * modelo aprovado; uma mensagem de texto livre é aceita pela API (este
 * teste passa) mas pode não chegar ao aparelho. Para ver a entrega, envie
 * antes qualquer mensagem do destinatário para o número de teste.
 */
loadBackendEnv();

const phoneNumberId = process.env.WHATSAPP_SMOKE_PHONE_NUMBER_ID;
const accessToken = process.env.WHATSAPP_SMOKE_ACCESS_TOKEN;
const to = process.env.WHATSAPP_SMOKE_TO;
const enabled = Boolean(phoneNumberId && accessToken && to && process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY);

const TENANT_ID = '00000000-0000-4000-8000-000000000002';

describe.skipIf(!enabled)('[MANUAL / EXTERNAL] Meta / WhatsApp — envio controlado para número de teste', () => {
  it('envia uma mensagem de texto e recebe o id da mensagem (wamid)', async () => {
    const tokenCipher = new TokenCipherService();
    const prismaClient = {
      whatsAppIntegration: {
        findUnique: async () => ({
          tenantId: TENANT_ID,
          phoneNumberId,
          accessToken: tokenCipher.encrypt(accessToken as string),
          active: true,
        }),
      },
    } as unknown as PrismaClientProvider;
    const provider = new WhatsAppMessageProvider(prismaClient, tokenCipher);

    const start = Date.now();
    const result = await provider.send({
      tenantId: TENANT_ID,
      toPhoneNumber: to as string,
      body: `[TESTE LUXORA] Mensagem de validação de integração — ${new Date().toISOString()}`,
      idempotencyKey: `smoke-whatsapp-${Date.now()}`,
      correlationId: 'smoke-whatsapp-send',
    });

    logSmoke('whatsapp', {
      chamada: 'POST /{phone-number-id}/messages',
      http: 200,
      id_mensagem: result.providerMessageId,
      latencia_ms: Date.now() - start,
    });

    expect(result.providerMessageId).toMatch(/^wamid\./);
  }, 30000);
});
