import { ConflictException } from '@nestjs/common';

/**
 * MessageChannelStatus — Tarefa 05 da auditoria. Diz se a clínica do
 * contexto atual tem um canal de mensagens conectado e ativo.
 *
 * Só confere se o canal existe: a credencial não é testada contra o
 * provider (isso exigiria uma chamada externa a cada consulta).
 */
export interface MessageChannelStatus {
  isConnected(): Promise<boolean>;
}

export const MESSAGE_CHANNEL_STATUS = Symbol('MESSAGE_CHANNEL_STATUS');

/**
 * A ação depende de enviar uma mensagem e a clínica não tem canal
 * conectado. Sem esta recusa o envio só falharia depois, no worker da fila
 * (falha permanente, sem aviso), com a ação já registrada como feita.
 */
export class MessageChannelNotConnectedError extends ConflictException {
  constructor() {
    super({
      code: 'WHATSAPP_NOT_CONNECTED',
      message: 'A clínica ainda não conectou o WhatsApp. Conecte o canal antes de enviar mensagens.',
      category: 'business_rule',
    });
  }
}
