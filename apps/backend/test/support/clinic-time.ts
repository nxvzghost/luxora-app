import { addCivilDays, civilDateIn, DEFAULT_CLINIC_TIME_ZONE, instantAt } from '@domain/shared/time-zone';

/** O fuso das clínicas de teste: o padrão do sistema, que é o que toda clínica recém-criada recebe. */
export const TEST_CLINIC_TIME_ZONE = DEFAULT_CLINIC_TIME_ZONE;

/**
 * Um horário de parede na clínica dos testes, `daysAhead` dias depois de hoje
 * no calendário dela — AD-039 (ADR-0064).
 *
 * Os testes montavam esses horários com `setDate`/`setHours`, que leem o fuso
 * do processo. Na máquina de desenvolvimento (Brasília) dava no mesmo; no CI
 * (UTC) "00:00 + n horas" caía três horas antes na clínica, e um horário
 * escolhido para caber na janela de atendimento podia ficar fora dela.
 * Daqui o horário sai o mesmo com o processo em qualquer fuso.
 */
export function clinicTimeAt(daysAhead: number, hour = 0, minute = 0, timeZone: string = TEST_CLINIC_TIME_ZONE): Date {
  const day = addCivilDays(civilDateIn(new Date(), timeZone), daysAhead);
  return instantAt(timeZone, day, { hour, minute });
}
