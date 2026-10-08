import { ApiError } from '@/lib/api-client/client';

/**
 * describeApiError — Tarefa 05 da auditoria.
 *
 * Transforma qualquer falha de chamada à API em uma frase que a equipe da
 * clínica entende e sobre a qual consegue agir. Antes, cada tela mostrava a
 * mensagem crua do servidor ou um "tente novamente" que não dizia o motivo.
 *
 * `fallback` é a frase da própria ação ("Não foi possível cancelar a
 * consulta."), usada quando não há nada mais específico a dizer.
 */
export function describeApiError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) {
    // fetch rejeitou: sem rede, servidor fora do ar, CORS.
    return 'Não foi possível falar com o servidor. Confira a conexão e tente de novo.';
  }

  switch (error.code) {
    case 'SUBSCRIPTION_INACTIVE':
      return 'A assinatura da clínica não está ativa. Regularize em Assinatura para continuar.';
    case 'SLOT_NOT_AVAILABLE':
      return 'Esse horário não está mais disponível. Escolha outro.';
    case 'SESSION_CONFLICT':
      return 'Outra pessoa acabou de ocupar esse horário. Atualize a lista e escolha outro.';
    case 'DUPLICATE_PAYMENT':
      return 'Esse pagamento já tinha sido registrado.';
    case 'WHATSAPP_NOT_CONNECTED':
      return 'A clínica ainda não conectou o WhatsApp, então nada foi enviado. Conecte o canal em Configurações e envie de novo.';
  }

  if (error.status === 401) return 'Sua sessão expirou. Entre novamente.';
  if (error.status === 403) return 'Seu perfil não tem permissão para esta ação.';
  if (error.status === 429) return 'Muitas tentativas em pouco tempo. Aguarde um minuto e tente de novo.';
  if (error.status >= 500) {
    return `${fallback} O servidor não concluiu a ação — atualize a página para ver o estado atual antes de tentar de novo.`;
  }
  // 404 e 409 trazem a regra de negócio em português, escrita pelo backend.
  if ((error.status === 404 || error.status === 409) && error.message) return error.message;
  // 400: a mensagem do validador é técnica e em inglês; vale a frase da ação.
  return fallback;
}

/** Erro que significa "ainda não existe", não uma falha (ex.: terapeuta sem disponibilidade gravada). */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
