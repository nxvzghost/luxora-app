import { Injectable } from '@nestjs/common';
import {
  MessageProvider,
  MessageProviderError,
  SendMessageInput,
  SendMessageResult,
} from '@domain-services/communication/message-provider';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { TokenCipherService } from '@shared/token-cipher.service';
import { WHATSAPP_GRAPH_API_URL } from './whatsapp-graph-api';

const DEFAULT_TIMEOUT_MS = 10000;

interface MetaErrorBody {
  error?: { code?: number; error_subcode?: number; type?: string; fbtrace_id?: string };
}

/**
 * Resume o corpo de erro da Graph API só com os campos de diagnóstico
 * (código, subcódigo, tipo, id de rastreio). O texto livre (`message`,
 * `error_data.details`) fica de fora: pode repetir o telefone do
 * destinatário, e esta string vai parar no log e no Redis (failedReason).
 */
function describeMetaError(rawBody: string): string {
  try {
    const { error } = JSON.parse(rawBody) as MetaErrorBody;
    if (!error) return 'corpo de erro sem o campo "error"';
    return [
      `code=${error.code ?? 'ausente'}`,
      `subcode=${error.error_subcode ?? 'ausente'}`,
      `type=${error.type ?? 'ausente'}`,
      `fbtrace_id=${error.fbtrace_id ?? 'ausente'}`,
    ].join(', ');
  } catch {
    return 'corpo de erro ilegível';
  }
}

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
 * NÃO TESTADO CONTRA A API REAL — nenhuma clínica tem canal conectado no
 * ambiente de desenvolvimento (ver test/manual/README.md).
 *
 * AD-005: accessToken é lido cifrado do banco e decifrado via
 * TokenCipherService antes de ser usado no header Authorization — este
 * Provider nunca sabe (nem precisa saber) qual é o formato de cifragem.
 *
 * Fase 3 da auditoria: toda falha sai como MessageProviderError, já
 * classificada (repetível ou permanente), com tempo limite na chamada
 * (WHATSAPP_PROVIDER_TIMEOUT_MS, padrão 10 s) e sem texto livre do
 * provider na mensagem.
 */
@Injectable()
export class WhatsAppMessageProvider implements MessageProvider {
  private readonly apiUrl = WHATSAPP_GRAPH_API_URL;
  private readonly timeoutMs = Number(process.env.WHATSAPP_PROVIDER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  constructor(
    private readonly prismaClient: PrismaClientProvider,
    private readonly tokenCipher: TokenCipherService,
  ) {}

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const integration = await this.prismaClient.whatsAppIntegration.findUnique({
      where: { tenantId: input.tenantId },
    });

    if (!integration || !integration.active) {
      throw new MessageProviderError(
        `Clínica (tenant ${input.tenantId}) não tem WhatsApp conectado. Cada clínica precisa conectar seu próprio canal antes de enviar mensagens.`,
        false,
      );
    }

    let accessToken: string;
    try {
      accessToken = this.tokenCipher.decrypt(integration.accessToken);
    } catch {
      throw new MessageProviderError(
        `Credencial de WhatsApp da clínica (tenant ${input.tenantId}) não pôde ser decifrada.`,
        false,
      );
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}/${integration.phoneNumberId}/messages`, {
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
        signal: controller.signal,
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'AbortError' ? `tempo limite de ${this.timeoutMs}ms` : 'falha de rede';
      throw new MessageProviderError(`Falha ao enviar mensagem via WhatsApp (${reason}).`, true);
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new MessageProviderError(
        `Falha ao enviar mensagem via WhatsApp (${response.status}): ${describeMetaError(await response.text())}`,
        retryable,
        response.status,
      );
    }

    // Resposta 2xx: a Meta já aceitou a mensagem. Um corpo sem o id não
    // pode virar erro — a fila repetiria o envio e o paciente receberia
    // a mesma mensagem duas vezes.
    let providerMessageId = '';
    try {
      const data = (await response.json()) as { messages?: Array<{ id?: string }> };
      providerMessageId = data.messages?.[0]?.id ?? '';
    } catch {
      providerMessageId = '';
    }

    return { providerMessageId, sentAt: new Date() };
  }
}
