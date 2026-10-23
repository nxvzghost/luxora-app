import { randomInt } from 'node:crypto';
import { clinicTimeAt } from '../../support/clinic-time';

/**
 * Gera um horário de agendamento sempre único — entre chamadas na mesma
 * execução, entre execuções repetidas contra o mesmo banco de
 * desenvolvimento persistente (sem reset entre rodadas), E entre arquivos
 * de teste diferentes rodando em paralelo (Vitest roda arquivos de
 * test/critical/ concorrentemente por padrão).
 *
 * Desde o Motor de Disponibilidade (ADR-0040, PD-001), "único" deixou de
 * significar só "scheduledAt exato não repetido" — VerificarDisponibilidadeUseCase
 * detecta sobreposição de intervalo real (ScheduleSlot.overlapsWith), então
 * duas chamadas em horários DIFERENTES mas dentro dos mesmos 60min também
 * colidem agora (SLOT_NOT_AVAILABLE), o que o índice único do banco nunca
 * detectava. Correção: cada processo de teste sorteia um offset-base de dias
 * bem afastado (0-9970, ~27 anos de faixa) e cada chamada dentro do MESMO
 * processo avança um contador fixo de dias — garante zero colisão entre
 * chamadas sequenciais do mesmo arquivo (o caso mais provável, ex:
 * billing-aggregation.test.ts chama isto várias vezes seguidas) e torna
 * colisão entre arquivos diferentes desprezível.
 */
const PROCESS_BASE_DAYS = randomInt(30, 9970);
let callCount = 0;

export function uniqueSlot(): string {
  const daysAhead = PROCESS_BASE_DAYS + callCount * 3;
  callCount += 1;

  const hour = randomInt(8, 18);
  const minute = randomInt(0, 60);
  // AD-039 — hora de parede na clínica de teste, não no fuso do processo.
  return clinicTimeAt(daysAhead, hour, minute).toISOString();
}

/**
 * K2-b — o mesmo, no passado: realização e falta só são registradas depois
 * do início previsto (ADR-0069, seção 2.5), então a consulta que vira sessão
 * a faturar precisa ter acontecido. Faixa própria de dias para trás, sem
 * cruzar com a de uniqueSlot().
 */
const PROCESS_BASE_DAYS_BACK = randomInt(2, 3000);
let pastCallCount = 0;

export function uniquePastSlot(): string {
  const daysBack = PROCESS_BASE_DAYS_BACK + pastCallCount * 3;
  pastCallCount += 1;
  return clinicTimeAt(-daysBack, randomInt(8, 18), randomInt(0, 60)).toISOString();
}
