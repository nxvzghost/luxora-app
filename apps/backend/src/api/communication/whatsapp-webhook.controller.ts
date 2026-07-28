import { Body, Controller, ForbiddenException, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { WhatsAppWebhookGuard } from './whatsapp-webhook.guard';
import { SkipSubscriptionCheck } from '../subscription/skip-subscription-check.decorator';
import {
  ReceberMensagemWhatsAppUseCase,
  WhatsAppWebhookPayload,
} from '@use-cases/communication/receber-mensagem-whatsapp.use-case';

/**
 * WhatsAppWebhookController — ADR-0053 (AD-007). Único ponto de entrada
 * real de mensagens do WhatsApp. Nenhuma rota aqui passa por JwtAuthGuard
 * — a Meta chama diretamente, sem JWT possível (GET é o handshake de
 * verificação, POST é protegido por assinatura HMAC, não por sessão).
 */
@ApiTags('webhooks')
@SkipSubscriptionCheck()
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(private readonly receberMensagem: ReceberMensagemWhatsAppUseCase) {}

  /**
   * Handshake de verificação (ADR-0053 §2.2) — a Meta chama uma única vez,
   * ao configurar o webhook no painel do App. Responde o `hub.challenge`
   * em texto puro (nunca JSON) só se `hub.verify_token` bater com o
   * segredo configurado.
   *
   * Sem `@Res()`/import de `express` de propósito — quebrava a resolução
   * de módulo do Vitest (achado real: `Failed to load url express`,
   * `express` é dependência transitiva aqui, não direta). Retornar a
   * string diretamente já produz o corpo em texto puro via o
   * RouterResponseController padrão do Nest (nunca JSON.stringify para
   * um valor primitivo) — mesmo resultado, sem a dependência direta.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') verifyToken: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    const expectedToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    if (!expectedToken) {
      throw new Error('WHATSAPP_WEBHOOK_VERIFY_TOKEN não configurado no ambiente.');
    }

    if (mode === 'subscribe' && verifyToken === expectedToken) {
      return challenge;
    }
    throw new ForbiddenException('Verify token inválido.');
  }

  /**
   * Recepção real — responde 200 o mais rápido possível (exigência da
   * Meta): a parte síncrona só valida, persiste de forma idempotente e
   * enfileira; o processamento de IA nunca bloqueia esta resposta (§4).
   */
  @Post()
  @UseGuards(WhatsAppWebhookGuard)
  @HttpCode(HttpStatus.OK)
  async receive(@Body() payload: WhatsAppWebhookPayload) {
    await this.receberMensagem.execute(payload);
    return { received: true };
  }
}
