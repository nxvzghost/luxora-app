/**
 * Templates da régua de inadimplência — Módulo 13.
 * Fonte: 02 - CTO/clinicos/docs/05-IA/03-Gestao-de-Inadimplencia.md, seção
 * "Fluxo da régua" — texto literal já validado, nunca parafrasear.
 *
 * Regra testada no Teste Crítico #14: nenhuma etapa menciona suspensão,
 * ameaça, juros ou multa.
 */
export function buildD1ReminderMessage(patientFirstName: string, dueDateFormatted: string): string {
  return `Olá, ${patientFirstName}! 😊\n\nNotei que ainda não recebemos a confirmação do pagamento de ${dueDateFormatted}. Está tudo bem?`;
}

export function buildD7ReminderMessage(patientFirstName: string): string {
  return `Oi, ${patientFirstName}. Passando novamente por aqui. 😊\n\nSe estiver passando por um momento mais difícil, me avisa — podemos conversar sobre isso.`;
}
