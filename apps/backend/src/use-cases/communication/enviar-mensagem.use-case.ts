import { Injectable, Inject } from '@nestjs/common';
import { MessageProvider, MESSAGE_PROVIDER } from '@domain-services/communication/message-provider';
import { MessageLogRepository, MESSAGE_LOG_REPOSITORY } from '@domain-services/communication/message-log.repository';

export interface EnviarMensagemInput {
  tenantId: string;
  toPhoneNumber: string;
  body: string;
  idempotencyKey: string;
  /** AD-016 — propagado explicitamente desde o payload do job da fila (ver MessageQueueWorker). */
  correlationId?: string;
}

/**
 * EnviarMensagemUseCase — Módulo 11.
 *
 * Idempotência em 2 camadas, mesmo padrão de RegistrarPagamentoUseCase
 * (Módulo 09): checagem explícita ANTES de enviar (evita chamar a API
 * externa desnecessariamente — diferente de banco, uma chamada HTTP repetida
 * tem custo real e efeito colateral visível ao paciente) + constraint
 * @unique no banco como rede de segurança contra corrida (dois workers de
 * fila processando o mesmo job por engano).
 *
 * POLÍTICA DE ENTREGA: AT-LEAST-ONCE (ADR-0058). A ordem "envia e depois
 * grava" é deliberada. Se a gravação falhar depois de a Meta aceitar a
 * mensagem, a nova tentativa envia de novo: a mensagem pode chegar
 * repetida, mas não se perde em silêncio. Inverter a ordem trocaria esse
 * risco pelo de perder a mensagem — não inverter sem decisão explícita.
 */
@Injectable()
export class EnviarMensagemUseCase {
  constructor(
    @Inject(MESSAGE_PROVIDER) private readonly provider: MessageProvider,
    @Inject(MESSAGE_LOG_REPOSITORY) private readonly logRepo: MessageLogRepository,
  ) {}

  async execute(input: EnviarMensagemInput): Promise<{ providerMessageId: string }> {
    const existing = await this.logRepo.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return { providerMessageId: existing.providerMessageId ?? '' }; // já enviada — nunca reenvia
    }

    const result = await this.provider.send({
      tenantId: input.tenantId,
      toPhoneNumber: input.toPhoneNumber,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
    });

    await this.logRepo.record({
      tenantId: input.tenantId,
      toPhoneNumber: input.toPhoneNumber,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      providerMessageId: result.providerMessageId,
    });

    return { providerMessageId: result.providerMessageId };
  }
}
