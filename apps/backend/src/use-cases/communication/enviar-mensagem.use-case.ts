import { Injectable, Inject } from '@nestjs/common';
import { MessageProvider, MESSAGE_PROVIDER } from '@domain-services/communication/message-provider';
import { MessageLogRepository, MESSAGE_LOG_REPOSITORY } from '@domain-services/communication/message-log.repository';

export interface EnviarMensagemInput {
  tenantId: string;
  toPhoneNumber: string;
  body: string;
  idempotencyKey: string;
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
