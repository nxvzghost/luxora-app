/**
 * Template do resumo diário de agenda — Módulo 14.
 * Fonte: 02 - CTO/clinicos/docs/05-IA/02-Rotina-de-Controle-de-Agenda.md.
 *
 * Extraído de EnviarResumoAgendaDoDiaUseCase durante a revisão geral, para
 * ser reaproveitado por ReenviarAgendaAtualizadaUseCase.
 */
export function buildAgendaSummaryMessage(
  therapistName: string,
  appointments: { scheduledAt: Date; state: string }[],
  updated = false,
): string {
  const firstName = therapistName.split(' ')[0];
  if (appointments.length === 0) {
    return updated
      ? `Olá, ${firstName}! 😊\n\nSua agenda de amanhã foi atualizada: agora você não tem nenhuma consulta agendada.`
      : `Olá, ${firstName}! 😊\n\nAmanhã você não tem nenhuma consulta agendada.`;
  }
  const lines = appointments
    .slice()
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
    .map((a) => {
      const time = a.scheduledAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const statusLabel = a.state === 'Confirmada' ? 'confirmado' : 'aguardando confirmação';
      return `${time} — paciente (${statusLabel})`;
    });
  const header = updated
    ? `Olá, ${firstName}! 😊\n\nSua agenda de amanhã foi atualizada:`
    : `Olá, ${firstName}! 😊\n\nSua agenda de amanhã:`;
  return [header, '', ...lines].join('\n');
}
