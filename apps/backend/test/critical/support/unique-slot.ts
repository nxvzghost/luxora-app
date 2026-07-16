import { randomInt } from 'node:crypto';

/**
 * Gera um horário de agendamento sempre único — entre chamadas na mesma
 * execução, entre execuções repetidas contra o mesmo banco de
 * desenvolvimento persistente (sem reset entre rodadas), E entre arquivos
 * de teste diferentes rodando em paralelo (Vitest roda arquivos de
 * test/critical/ concorrentemente por padrão — dois arquivos calculando
 * Date.now() dentro da mesma janela de poucos milissegundos podiam colidir
 * no mesmo scheduled_at, disparando SESSION_CONFLICT no teste errado).
 * Espalha em um range de +30 a +400 dias no futuro com hora/minuto
 * aleatórios — a data em si é irrelevante para o que está sendo testado.
 */
export function uniqueSlot(): string {
  const daysAhead = randomInt(30, 400);
  const hour = randomInt(8, 18);
  const minute = randomInt(0, 60);
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}
