/**
 * Retenção de jobs do BullMQ no Redis — Fase 3B da auditoria.
 *
 * ACHADO REAL: nenhuma fila definia retenção, e o padrão do BullMQ é
 * guardar jobs concluídos e falhados para sempre. O payload leva telefone
 * e texto de mensagem; o Redis guarda tudo em memória. Medido no Redis
 * local: jobs de julho ainda presentes em outubro, sem prazo de expiração.
 *
 * Política (valores em segundos, como o BullMQ espera em `age`):
 *
 * - Concluídos: 24 horas, nas duas filas. É a janela em que o `jobId`
 *   ainda barra um reenfileiramento repetido; depois disso a idempotência
 *   continua garantida pelo Postgres (`message_log`, `message.external_id`,
 *   `inbound_processing_inbox`).
 *
 * - Falhados, fila de saída: 14 dias. Um envio que falhou em definitivo
 *   (3 tentativas, ou falha permanente na 1ª) não deixa registro em
 *   `message_log` — o job falhado é o único rastro, e não existe alerta.
 *   Sem alerta, o diagnóstico depende de alguém olhar; 14 dias cobre duas
 *   revisões semanais.
 *
 * - Falhados, fila de entrada: 7 dias. Aqui o rastro durável já existe no
 *   Postgres (`inbound_processing_inbox`, estado `failed` com o motivo), e
 *   a cópia no Redis carrega o texto escrito pelo paciente — fica o mínimo.
 *
 * Como o BullMQ aplica: a limpeza acontece quando outro job da mesma fila
 * termina. Numa fila parada, jobs vencidos permanecem até o próximo job
 * concluir ou falhar. Jobs que nunca foram processados (em espera) não são
 * afetados.
 */
const HOUR_IN_SECONDS = 60 * 60;
const DAY_IN_SECONDS = 24 * HOUR_IN_SECONDS;

export const COMPLETED_JOB_RETENTION = { age: 24 * HOUR_IN_SECONDS } as const;

export const FAILED_OUTBOUND_JOB_RETENTION = { age: 14 * DAY_IN_SECONDS } as const;

export const FAILED_INBOUND_JOB_RETENTION = { age: 7 * DAY_IN_SECONDS } as const;
