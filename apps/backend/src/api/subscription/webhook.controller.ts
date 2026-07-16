import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AsaasWebhookGuard } from './asaas-webhook.guard';
import { SkipSubscriptionCheck } from './skip-subscription-check.decorator';
import { ProcessarWebhookAssinaturaUseCase, AsaasWebhookPayload } from '@use-cases/subscription/processar-webhook-assinatura.use-case';

/**
 * WebhookController — Módulo 17. Responde 2xx o mais rápido possível
 * (exigência da doc oficial da Asaas). Processamento síncrono por
 * simplicidade do MVP.
 *
 * @SkipSubscriptionCheck() explícito, mesmo este Controller nunca passando
 * por JwtAuthGuard (então TenantContext nunca estaria inicializado aqui de
 * qualquer forma) — defesa em profundidade, não depende de comportamento
 * implícito que poderia quebrar se a ordem dos guards mudar no futuro.
 */
@ApiTags('webhooks')
@UseGuards(AsaasWebhookGuard)
@SkipSubscriptionCheck()
@Controller('webhooks/asaas')
export class WebhookController {
  constructor(private readonly processarWebhook: ProcessarWebhookAssinaturaUseCase) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(@Body() payload: AsaasWebhookPayload) {
    await this.processarWebhook.execute(payload);
    return { received: true };
  }
}
