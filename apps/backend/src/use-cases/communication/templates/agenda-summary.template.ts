import { addCivilDays, civilDateIn, type CivilDate, localDayRange } from '@domain/shared/time-zone';

/**
 * "Amanhã" para o resumo de agenda — AD-039 (ADR-0064): o dia seguinte ao
 * de hoje no calendário da clínica, com o primeiro e o último instante
 * dele. Às 22:00 de São Paulo o processo, em UTC, já está no dia seguinte;
 * o "amanhã" que vale é o de quem recebe a mensagem.
 */
export function tomorrowAt(timeZone: string, now: Date = new Date()): { date: CivilDate; from: Date; to: Date } {
  const date = addCivilDays(civilDateIn(now, timeZone), 1);
  return { date, ...localDayRange(timeZone, date) };
}

/**
 * Template do resumo diário de agenda — Módulo 14.
 * Fonte: 02 - CTO/clinicos/docs/05-IA/02-Rotina-de-Controle-de-Agenda.md.
 *
 * Extraído de EnviarResumoAgendaDoDiaUseCase durante a revisão geral, para
 * ser reaproveitado por ReenviarAgendaAtualizadaUseCase.
 *
 * AD-039 — os horários são escritos no fuso da clínica (`timeZone`), não no
 * do processo.
 */
export function buildAgendaSummaryMessage(
  therapistName: string,
  appointments: { scheduledAt: Date; state: string }[],
  timeZone: string,
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
      const time = a.scheduledAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone });
      const statusLabel = a.state === 'Confirmada' ? 'confirmado' : 'aguardando confirmação';
      return `${time} — paciente (${statusLabel})`;
    });
  const header = updated
    ? `Olá, ${firstName}! 😊\n\nSua agenda de amanhã foi atualizada:`
    : `Olá, ${firstName}! 😊\n\nSua agenda de amanhã:`;
  return [header, '', ...lines].join('\n');
}
