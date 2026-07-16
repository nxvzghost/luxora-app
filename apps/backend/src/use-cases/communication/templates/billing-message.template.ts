/**
 * Templates de mensagem — Módulo 11.
 * Fonte: 02 - CTO/clinicos/docs/05-IA/01-Tom-de-Voz-e-Estilo-Conversacional.md,
 * Padrão 7 — "usar exatamente este modelo, não uma variação livre".
 */
export function buildBillingMessage(params: {
  patientFirstName: string;
  sessionCount: number;
  amountPerSession: number;
  totalAmount: number;
  pixKey: string;
  payeeName: string;
}): string {
  return [
    `Olá, ${params.patientFirstName}, boa tarde! 😊`,
    'Segue abaixo o detalhamento da sua sessão:',
    '',
    `💼 Sessões realizadas: ${params.sessionCount}`,
    `💰 Valor por sessão: R$${params.amountPerSession.toFixed(2)}`,
    `🔢 Total a pagar: R$${params.totalAmount.toFixed(2)}`,
    '',
    'Pagamento via Pix:',
    `📱 Chave: ${params.pixKey}`,
    `👤 Nome: ${params.payeeName}`,
    '',
    'Caso o pagamento já tenha sido realizado, poderia nos enviar o comprovante, por gentileza?',
    '',
    'Fico à disposição para qualquer dúvida.',
  ].join('\n');
}
