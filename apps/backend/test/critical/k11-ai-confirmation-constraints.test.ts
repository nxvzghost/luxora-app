import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { K11_CONSTRAINTS, K11Constraint } from './support/k11-constraints';

/**
 * [CRÍTICO — K11] Cada restrição da migration 20261023220000 recusa a linha
 * que a viola, pelo próprio nome (ADR-0069, K11; D1, D2 e D4).
 *
 * O que o banco garante, venha a escrita de que versão vier:
 *   - o desfecho de autoria `ai_agent` só existe para cancelamento ou
 *     remarcação, sem usuário, ligado a um pedido da mesma consulta com a
 *     ação correspondente e a uma resposta `confirma` desse pedido, recebida
 *     antes do início;
 *   - a resposta é outra linha, da mesma consulta e da mesma conversa do
 *     pedido (e cada mensagem gera no máximo uma comunicação: message_id
 *     único, da K2-b);
 *   - o desfecho registrado por pessoa continua exigindo o usuário.
 * Que a resposta tenha chegado DEPOIS do pedido não cabe numa restrição sem
 * trigger: é regra do caso de uso, provada em k11-whatsapp-request-flow.test.ts.
 *
 * Mesmo método de appointment-outcome-k2b-constraints.test.ts: controle (a
 * linha válida mais próxima é aceita) e violação (a mesma linha com um único
 * campo errado é recusada por ESSA restrição), numa transação do
 * superusuário que sempre é desfeita.
 */

let db: PrismaClient;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

const ACCEPTED = 'P0999';
const NOW = '2026-10-20 10:00:00';

type Value = string | number | boolean | null;
type Row = Record<string, Value>;

const literal = (value: Value): string =>
  value === null ? 'NULL' : typeof value === 'number' || typeof value === 'boolean' ? String(value) : `'${value.replace(/'/g, "''")}'`;

function insert(table: string, row: Row): string {
  const columns = Object.keys(row).map((column) => `"${column}"`);
  return `INSERT INTO "public"."${table}" (${columns.join(', ')}) VALUES (${Object.values(row).map(literal).join(', ')})`;
}

function scenarioIds() {
  const run = randomUUID();
  const id = (name: string) => `k11c-${name}-${run}`;
  return {
    t1: id('t1'),
    t2: id('t2'),
    p1: id('p1'),
    p3: id('p3'),
    th1: id('th1'),
    a1: id('a1'),
    a2: id('a2'),
    a4: id('a4'),
    c1: id('c1'),
    c2: id('c2'),
    c3: id('c3'),
    req1: id('req1'),
    req4: id('req4'),
    rep4: id('rep4'),
    rec4: id('rec4'),
    late4: id('late4'),
    rem4: id('rem4'),
    remrep4: id('remrep4'),
    panel4: id('panel4'),
    nx: id('nx'),
  };
}
type Ids = ReturnType<typeof scenarioIds>;

const A1_AT = '2026-10-22 10:00:00';
const A4_AT = '2026-10-22 12:00:00';
const NEW_SLOT = '2026-10-25 12:00:00';

/** Pedido de cancelamento feito pelo WhatsApp, registrado pela IA, aguardando confirmação (a1, conversa c1). */
const aiRequest = (k: Ids): Row => ({
  id: k.nx,
  tenant_id: k.t1,
  appointment_id: k.a1,
  patient_id: k.p1,
  channel: 'whatsapp',
  message_id: `wamid.${k.nx}`,
  received_at: '2026-10-20 09:00:00',
  recorded_at: NOW,
  reference_time: '2026-10-20 09:00:00',
  reference_source: 'recebimento_webhook',
  timing: 'sem_limite_configurado',
  minutes_from_start: 2940,
  intent: 'pedido_cancelamento',
  intent_source: 'ia',
  requested_by: 'paciente',
  recorded_by_user_id: null,
  recorded_by_actor_type: 'ai_agent',
  review_status: 'sem_revisao_necessaria',
  conversation_id: k.c1,
  awaits_confirmation: true,
  requested_action: 'cancelar',
  asked_scheduled_at: A1_AT,
  asked_modality: 'presencial',
});

/** A resposta `confirma` ao pedido req1, em outra mensagem da mesma conversa. */
const aiReply = (k: Ids): Row => ({
  ...aiRequest(k),
  message_id: `wamid.${k.nx}`,
  received_at: '2026-10-20 09:05:00',
  reference_time: '2026-10-20 09:05:00',
  minutes_from_start: 2935,
  awaits_confirmation: false,
  requested_action: null,
  asked_scheduled_at: null,
  asked_modality: null,
  confirms_notice_id: k.req1,
  confirmation_answer: 'confirma',
});

/** Cancelamento de a4 (já Cancelada) pela IA: o pedido req4 e a confirmação rep4. */
const aiOutcome = (k: Ids): Row => ({
  appointment_id: k.a4,
  tenant_id: k.t1,
  outcome: 'Cancelada',
  outcome_recorded_by_user_id: null,
  outcome_recorded_by_actor_type: 'ai_agent',
  state_at_outcome: 'Cancelada',
  scheduled_at_at_outcome: A4_AT,
  modality_at_outcome: 'presencial',
  closing_notice_id: k.req4,
  closing_notice_timing: 'sem_limite_configurado',
  closing_requested_action: 'cancelar',
  confirmation_notice_id: k.rep4,
  confirmation_answer: 'confirma',
  confirmation_notice_timing: 'sem_limite_configurado',
});

/** Remarcação de a4 pela IA: o pedido rem4 e a confirmação remrep4. */
const aiRescheduleOutcome = (k: Ids): Row => ({
  ...aiOutcome(k),
  outcome: 'Remarcada',
  closing_notice_id: k.rem4,
  closing_requested_action: 'remarcar',
  confirmation_notice_id: k.remrep4,
});

/** Cancelamento de a4 por pessoa, pelo painel (a forma da K2-b). */
const userOutcome = (k: Ids): Row => ({
  appointment_id: k.a4,
  tenant_id: k.t1,
  outcome: 'Cancelada',
  outcome_recorded_by_user_id: 'u1',
  state_at_outcome: 'Cancelada',
  scheduled_at_at_outcome: A4_AT,
  modality_at_outcome: 'presencial',
  closing_notice_id: k.panel4,
  closing_notice_timing: 'sem_limite_configurado',
});

function seed(k: Ids): string[] {
  const appointment = (id: string, scheduledAt: string, state: string) =>
    insert('appointment', { id, tenant_id: k.t1, patient_id: k.p1, therapist_id: k.th1, scheduled_at: scheduledAt, state, modality: 'presencial', updated_at: NOW });
  const request = (id: string, appointmentId: string, at: string, change: Row = {}) =>
    insert('appointment_notice', {
      ...aiRequest(k),
      id,
      appointment_id: appointmentId,
      message_id: `wamid.${id}`,
      asked_scheduled_at: appointmentId === k.a4 ? A4_AT : A1_AT,
      received_at: at,
      reference_time: at,
      ...change,
    });
  const reply = (id: string, of: string, answer: string, at: string, change: Row = {}) =>
    insert('appointment_notice', {
      ...aiReply(k),
      id,
      appointment_id: k.a4,
      message_id: `wamid.${id}`,
      confirms_notice_id: of,
      confirmation_answer: answer,
      received_at: at,
      reference_time: at,
      review_status: answer === 'confirma' ? 'sem_revisao_necessaria' : 'pendente',
      ...change,
    });
  return [
    insert('tenant', { id: k.t1, name: 'Clínica K11 A', updated_at: NOW }),
    insert('tenant', { id: k.t2, name: 'Clínica K11 B', updated_at: NOW }),
    insert('patient', { id: k.p1, tenant_id: k.t1, name: 'Paciente 1', phone: '5527990001101', updated_at: NOW }),
    insert('patient', { id: k.p3, tenant_id: k.t2, name: 'Paciente 3', phone: '5527990001103', updated_at: NOW }),
    insert('therapist', { id: k.th1, tenant_id: k.t1, name: 'Terapeuta A', updated_at: NOW }),
    appointment(k.a1, A1_AT, 'Reservada'),
    appointment(k.a2, '2026-10-23 10:00:00', 'Reservada'),
    appointment(k.a4, A4_AT, 'Cancelada'),
    insert('conversation', { id: k.c1, tenant_id: k.t1, phone_number: '5527990001101', patient_id: k.p1 }),
    insert('conversation', { id: k.c2, tenant_id: k.t1, phone_number: '5527990001102' }),
    insert('conversation', { id: k.c3, tenant_id: k.t2, phone_number: '5527990001103', patient_id: k.p3 }),
    request(k.req1, k.a1, '2026-10-20 09:00:00'),
    request(k.req4, k.a4, '2026-10-20 08:00:00'),
    reply(k.rep4, k.req4, 'confirma', '2026-10-20 08:05:00'),
    reply(k.rec4, k.req4, 'recusa', '2026-10-20 08:06:00'),
    // Confirmação depois do início de a4: classificada como tal.
    reply(k.late4, k.req4, 'confirma', '2026-10-22 12:05:00', { timing: 'depois_do_inicio', minutes_from_start: -5, review_status: 'pendente' }),
    request(k.rem4, k.a4, '2026-10-20 08:10:00', { intent: 'pedido_remarcacao', requested_action: 'remarcar', proposed_scheduled_at: NEW_SLOT }),
    reply(k.remrep4, k.rem4, 'confirma', '2026-10-20 08:15:00', { intent: 'pedido_remarcacao' }),
    insert('appointment_notice', {
      id: k.panel4,
      tenant_id: k.t1,
      appointment_id: k.a4,
      patient_id: k.p1,
      channel: 'painel',
      recorded_at: '2026-10-20 08:00:00',
      reference_time: '2026-10-20 08:00:00',
      reference_source: 'registro_no_painel',
      timing: 'sem_limite_configurado',
      minutes_from_start: 3120,
      intent: 'pedido_cancelamento',
      intent_source: 'pessoa',
      requested_by: 'paciente',
      recorded_by_user_id: 'u1',
      recorded_by_actor_type: 'user',
      review_status: 'sem_revisao_necessaria',
    }),
  ];
}

type Attempt = [label: string, sql: (k: Ids) => string];

const noticeAttempt = (label: string, base: (k: Ids) => Row, change: (k: Ids) => Row = () => ({})): Attempt => [
  label,
  (k) => insert('appointment_notice', { ...base(k), ...change(k) }),
];
const outcomeAttempt = (label: string, base: (k: Ids) => Row, change: (k: Ids) => Row = () => ({})): Attempt => [
  label,
  (k) => insert('appointment_outcome', { ...base(k), ...change(k) }),
];

const REQUEST = noticeAttempt('pedido de cancelamento da IA, aguardando confirmação', aiRequest);
const RESCHEDULE_REQUEST = noticeAttempt('pedido de remarcação com o horário novo', aiRequest, () => ({
  intent: 'pedido_remarcacao',
  requested_action: 'remarcar',
  proposed_scheduled_at: NEW_SLOT,
}));
const NO_SHOW_REQUEST = noticeAttempt('"não vou conseguir ir" como pedido de cancelamento (D7)', aiRequest, () => ({ intent: 'nao_comparecera' }));
const REPLY = noticeAttempt('resposta "confirma" ao pedido, na mesma conversa', aiReply);
const REFUSAL = noticeAttempt('resposta "recusa", pendente de revisão', aiReply, () => ({ confirmation_answer: 'recusa', review_status: 'pendente' }));
const AI_OUTCOME = outcomeAttempt('cancelamento pela IA com o pedido e a confirmação', aiOutcome);
const AI_RESCHEDULE = outcomeAttempt('remarcação pela IA com o pedido e a confirmação', aiRescheduleOutcome);
const USER_OUTCOME = outcomeAttempt('cancelamento por pessoa, pelo painel (K2-b)', userOutcome);

const CASES: Record<K11Constraint, { controls: Attempt[]; violations: Attempt[] }> = {
  appointment_notice_request_check: {
    controls: [REQUEST, RESCHEDULE_REQUEST, NO_SHOW_REQUEST, REPLY],
    violations: [
      noticeAttempt('aguardando confirmação sem a ação pedida', aiRequest, () => ({ requested_action: null })),
      noticeAttempt('ação pedida sem aguardar confirmação', aiRequest, () => ({ awaits_confirmation: false })),
      noticeAttempt('pedido registrado por pessoa', aiRequest, () => ({ recorded_by_actor_type: 'user', recorded_by_user_id: 'u1' })),
      noticeAttempt('pedido feito pela clínica', aiRequest, () => ({ requested_by: 'clinica' })),
      // NULL num CHECK seria aceito sem o COALESCE: o caso prova que não é.
      noticeAttempt('pedido sem quem pediu', aiRequest, () => ({ requested_by: null })),
      noticeAttempt('pedido fora de uma conversa', aiRequest, () => ({ conversation_id: null })),
      noticeAttempt('pedido sem o retrato da consulta perguntada', aiRequest, () => ({ asked_scheduled_at: null })),
      noticeAttempt('pedido sem a modalidade perguntada', aiRequest, () => ({ asked_modality: null })),
      noticeAttempt('cancelamento com intenção de remarcar', aiRequest, () => ({ intent: 'pedido_remarcacao' })),
      noticeAttempt('remarcação com intenção de cancelar', aiRequest, () => ({ requested_action: 'remarcar', proposed_scheduled_at: NEW_SLOT })),
      noticeAttempt('remarcação sem o horário novo', aiRequest, () => ({ intent: 'pedido_remarcacao', requested_action: 'remarcar' })),
      noticeAttempt('cancelamento com horário novo', aiRequest, () => ({ proposed_scheduled_at: NEW_SLOT })),
    ],
  },
  appointment_notice_reply_check: {
    controls: [REPLY, REFUSAL, REQUEST],
    violations: [
      noticeAttempt('resposta sem o pedido a que responde', aiReply, () => ({ confirms_notice_id: null })),
      noticeAttempt('ligada a um pedido, sem a resposta', aiReply, () => ({ confirmation_answer: null })),
      noticeAttempt('resposta que é ela mesma um pedido', aiReply, () => ({ awaits_confirmation: true, requested_action: 'cancelar', asked_scheduled_at: A1_AT, asked_modality: 'presencial' })),
      noticeAttempt('resposta registrada por pessoa', aiReply, () => ({ recorded_by_actor_type: 'user', recorded_by_user_id: 'u1' })),
      noticeAttempt('resposta fora de uma conversa', aiReply, () => ({ conversation_id: null })),
    ],
  },
  appointment_notice_conversation_fkey: {
    controls: [REQUEST],
    violations: [
      noticeAttempt('pedido numa conversa de outra clínica', aiRequest, (k) => ({ conversation_id: k.c3 })),
      noticeAttempt('pedido numa conversa que não existe', aiRequest, (k) => ({ conversation_id: `${k.c1}-x` })),
    ],
  },
  appointment_notice_confirms_fkey: {
    controls: [REPLY],
    violations: [
      noticeAttempt('resposta vinda de outra conversa (outro contato)', aiReply, (k) => ({ conversation_id: k.c2 })),
      noticeAttempt('resposta gravada em outra consulta', aiReply, (k) => ({ appointment_id: k.a2 })),
      noticeAttempt('resposta a uma comunicação que não existe', aiReply, (k) => ({ confirms_notice_id: `${k.req1}-x` })),
    ],
  },
  appointment_outcome_actor_check: {
    controls: [AI_OUTCOME, AI_RESCHEDULE, USER_OUTCOME],
    violations: [
      outcomeAttempt('desfecho da IA com usuário', aiOutcome, () => ({ outcome_recorded_by_user_id: 'u1' })),
      outcomeAttempt('desfecho da IA sem a confirmação', aiOutcome, () => ({ confirmation_notice_id: null, confirmation_answer: null, confirmation_notice_timing: null })),
      outcomeAttempt('desfecho da IA com uma recusa no lugar da confirmação', aiOutcome, (k) => ({ confirmation_notice_id: k.rec4, confirmation_answer: 'recusa' })),
      outcomeAttempt('desfecho da IA com confirmação depois do início', aiOutcome, (k) => ({ confirmation_notice_id: k.late4, confirmation_notice_timing: 'depois_do_inicio' })),
      outcomeAttempt('desfecho da IA cancelando um pedido de remarcação', aiOutcome, () => ({ closing_requested_action: 'remarcar' })),
      // Os três casos com NULL: sem o COALESCE, o CHECK aceitaria e a chave composta (MATCH SIMPLE) não conferiria a linha.
      outcomeAttempt('desfecho da IA sem a ação do pedido', aiOutcome, () => ({ closing_requested_action: null })),
      outcomeAttempt('desfecho da IA sem a resposta classificada', aiOutcome, () => ({ confirmation_answer: null })),
      outcomeAttempt('desfecho da IA sem a classificação da confirmação', aiOutcome, () => ({ confirmation_notice_timing: null })),
      outcomeAttempt('desfecho do sistema', aiOutcome, () => ({ outcome_recorded_by_actor_type: 'system' })),
      outcomeAttempt('desfecho por pessoa sem o usuário', userOutcome, () => ({ outcome_recorded_by_user_id: null })),
      outcomeAttempt('desfecho por pessoa com a confirmação de um pedido', userOutcome, (k) => ({
        confirmation_notice_id: k.rep4,
        confirmation_answer: 'confirma',
        confirmation_notice_timing: 'sem_limite_configurado',
      })),
      outcomeAttempt('desfecho por pessoa com a ação de um pedido', userOutcome, () => ({ closing_requested_action: 'cancelar' })),
    ],
  },
  appointment_outcome_request_fkey: {
    controls: [AI_OUTCOME, AI_RESCHEDULE],
    violations: [
      outcomeAttempt('remarcação pela IA de um pedido de cancelamento', aiOutcome, () => ({ outcome: 'Remarcada', closing_requested_action: 'remarcar' })),
      outcomeAttempt('desfecho da IA fechando uma comunicação do painel', aiOutcome, (k) => ({ closing_notice_id: k.panel4 })),
    ],
  },
  appointment_outcome_confirmation_fkey: {
    controls: [AI_OUTCOME, AI_RESCHEDULE],
    violations: [
      outcomeAttempt('confirmação de outro pedido', aiOutcome, (k) => ({ confirmation_notice_id: k.remrep4 })),
      outcomeAttempt('uma recusa apresentada como confirmação', aiOutcome, (k) => ({ confirmation_notice_id: k.rec4 })),
      outcomeAttempt('confirmação depois do início apresentada como antes', aiOutcome, (k) => ({ confirmation_notice_id: k.late4 })),
      outcomeAttempt('o próprio pedido no lugar da confirmação', aiOutcome, (k) => ({ confirmation_notice_id: k.req4 })),
      outcomeAttempt('classificação da confirmação diferente da gravada', aiOutcome, () => ({ confirmation_notice_timing: 'no_prazo' })),
    ],
  },
};

const attemptBlock = (n: number, sql: string): string => `
  DO $attempt$
  DECLARE
    failed_state text;
    failed_constraint text;
  BEGIN
    BEGIN
      ${sql};
      RAISE EXCEPTION USING ERRCODE = '${ACCEPTED}';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS failed_state = RETURNED_SQLSTATE, failed_constraint = CONSTRAINT_NAME;
    END;
    INSERT INTO "k11_attempt" VALUES (${n}, failed_state, NULLIF(failed_constraint, ''));
  END $attempt$`;

class ScenarioRolledBack extends Error {}

async function attemptAll(attempts: Attempt[]): Promise<Array<[string, string]>> {
  const k = scenarioIds();
  type AttemptRow = { n: number; sqlstate: string; constraint_name: string | null };
  let rows: AttemptRow[] = [];
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE "k11_attempt" ("n" int PRIMARY KEY, "sqlstate" text NOT NULL, "constraint_name" text) ON COMMIT DROP`);
        for (const sql of seed(k)) await tx.$executeRawUnsafe(sql);
        for (const [n, [, sql]] of attempts.entries()) await tx.$executeRawUnsafe(attemptBlock(n, sql(k)));
        rows = await tx.$queryRawUnsafe<AttemptRow[]>(`SELECT "n", "sqlstate", "constraint_name" FROM "k11_attempt" ORDER BY "n"`);
        throw new ScenarioRolledBack();
      },
      { timeout: 30_000 },
    );
  } catch (err) {
    if (!(err instanceof ScenarioRolledBack)) throw err;
  }
  return rows.map((row) => [
    attempts[row.n][0],
    row.sqlstate === ACCEPTED ? 'aceita' : `recusada por ${row.constraint_name ?? '(nenhuma restrição)'} (${row.sqlstate})`,
  ]);
}

beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('[CRÍTICO — K11] cada restrição do banco recusa a linha que a viola, pelo próprio nome', () => {
  it('as 7 restrições do K11 têm casos, cada uma com controle e violação', () => {
    expect(Object.keys(CASES).sort()).toEqual([...K11_CONSTRAINTS].sort());
    for (const [constraint, { controls, violations }] of Object.entries(CASES)) {
      expect(controls.length, constraint).toBeGreaterThan(0);
      expect(violations.length, constraint).toBeGreaterThan(0);
    }
  });

  it.each(K11_CONSTRAINTS)('%s', async (constraint) => {
    const { controls, violations } = CASES[constraint];
    const refused = `recusada por ${constraint} (${constraint.endsWith('_fkey') ? '23503' : '23514'})`;
    expect(await attemptAll([...controls, ...violations])).toEqual([
      ...controls.map(([label]) => [label, 'aceita']),
      ...violations.map(([label]) => [label, refused]),
    ]);
  });

  it('a mesma mensagem não vira duas comunicações: pedido e confirmação nunca são a mesma mensagem', async () => {
    expect(
      await attemptAll([noticeAttempt('resposta com o message_id do próprio pedido', aiReply, (k) => ({ message_id: `wamid.${k.req1}` }))]),
    ).toEqual([['resposta com o message_id do próprio pedido', expect.stringMatching(/^recusada por appointment_notice_message_id_key \(23505\)$/)]]);
  });

  it('nada dos cenários fica gravado', async () => {
    expect(await db.tenant.count({ where: { id: { startsWith: 'k11c-' } } })).toBe(0);
  });
});
