import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { K2B_CONSTRAINTS, K2bConstraint } from './support/k2b-constraints';

/**
 * [CRÍTICO — K2-b] Cada restrição da migration 20261023130014 recusa a linha
 * que a viola, pelo próprio nome (ADR-0069, seções 2.7 e 3.7; condição 1 do
 * encerramento do K2, seção 9.4).
 *
 * A guarda de appointment-outcome-k2b.test.ts confere que as 23 restrições
 * existem e estão validadas, mas isso não prova o que cada uma recusa. Aqui
 * cada restrição tem os seus casos:
 *   - controle: a linha válida mais próxima é aceita (o cenário não falha por
 *     outro motivo);
 *   - violação: a mesma linha com um único campo errado é recusada por ESSA
 *     restrição — outro erro qualquer não conta.
 * Se a restrição sumir, ficar mais fraca ou deixar de valer, a violação passa
 * e o teste falha.
 *
 * Tudo roda numa transação do superusuário que sempre é desfeita, num cenário
 * próprio (duas clínicas, ids novos): nada fica gravado e nada é compartilhado
 * com os outros arquivos. Cada tentativa fica num bloco com tratamento de
 * exceção (subtransação), que guarda o SQLSTATE e o nome da restrição numa
 * tabela temporária — por GET STACKED DIAGNOSTICS, sem depender do idioma das
 * mensagens — e desfaz a instrução, aceita ou não. O superusuário ignora RLS e
 * privilégios; CHECKs e chaves estrangeiras valem para qualquer papel (RLS e
 * privilégios estão provados em appointment-outcome-k2b.test.ts).
 */

let db: PrismaClient;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

/** SQLSTATE que o bloco de tentativa levanta para desfazer uma instrução aceita. */
const ACCEPTED = 'P0999';
const NOW = '2026-10-20 10:00:00';

type Value = string | number | null;
type Row = Record<string, Value>;

const literal = (value: Value): string =>
  value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`;

function insert(table: string, row: Row): string {
  const columns = Object.keys(row).map((column) => `"${column}"`);
  return `INSERT INTO "public"."${table}" (${columns.join(', ')}) VALUES (${Object.values(row).map(literal).join(', ')})`;
}

function update(table: string, id: string, set: Row): string {
  const assignments = Object.entries(set).map(([column, value]) => `"${column}" = ${literal(value)}`);
  return `UPDATE "public"."${table}" SET ${assignments.join(', ')} WHERE "id" = ${literal(id)}`;
}

/** Ids novos a cada cenário. */
function scenarioIds() {
  const run = randomUUID();
  const id = (name: string) => `k2bc-${name}-${run}`;
  return {
    t1: id('t1'),
    t2: id('t2'),
    p1: id('p1'),
    p2: id('p2'),
    p3: id('p3'),
    th1: id('th1'),
    th2: id('th2'),
    a1: id('a1'),
    a2: id('a2'),
    a4: id('a4'),
    a5: id('a5'),
    a6: id('a6'),
    a7: id('a7'),
    s1: id('s1'),
    s2: id('s2'),
    s3: id('s3'),
    b1: id('b1'),
    n1: id('n1'),
    n2: id('n2'),
    n3: id('n3'),
    n4: id('n4'),
    nx: id('nx'),
    nw: id('nw'),
    d1: id('d1'),
    l1: id('l1'),
  };
}
type Ids = ReturnType<typeof scenarioIds>;

// Linhas válidas de partida. Cada caso muda só o campo que viola.

/** Falta em a1 (Reservada, no passado), aguardando a decisão de cobrança. */
const noShowOutcome = (k: Ids): Row => ({
  appointment_id: k.a1,
  tenant_id: k.t1,
  outcome: 'Falta',
  outcome_recorded_by_user_id: 'u1',
  state_at_outcome: 'Reservada',
  scheduled_at_at_outcome: '2026-10-01 10:00:00',
  modality_at_outcome: 'presencial',
  no_show_decision: 'aguardando_decisao',
});

/** Aviso tardio em a1, encerrado pela comunicação n2 (depois do início). */
const lateNoticeOutcome = (k: Ids): Row => ({
  appointment_id: k.a1,
  tenant_id: k.t1,
  outcome: 'AvisoTardio',
  outcome_recorded_by_user_id: 'u1',
  state_at_outcome: 'Reservada',
  scheduled_at_at_outcome: '2026-10-01 10:00:00',
  modality_at_outcome: 'presencial',
  closing_notice_id: k.n2,
  closing_notice_timing: 'depois_do_inicio',
  late_notice_decision: 'aguardando_decisao',
});

/** Cancelamento de a4 (já Cancelada), encerrado pela comunicação n1 (no prazo). */
const cancelledOutcome = (k: Ids): Row => ({
  appointment_id: k.a4,
  tenant_id: k.t1,
  outcome: 'Cancelada',
  outcome_recorded_by_user_id: 'u1',
  state_at_outcome: 'Cancelada',
  scheduled_at_at_outcome: '2026-10-01 12:00:00',
  modality_at_outcome: 'presencial',
  closing_notice_id: k.n1,
  closing_notice_timing: 'no_prazo',
});

/** Comunicação registrada pelo painel: a referência é o próprio registro. */
const panelNotice = (k: Ids): Row => ({
  id: k.nx,
  tenant_id: k.t1,
  appointment_id: k.a1,
  patient_id: k.p1,
  channel: 'painel',
  recorded_at: NOW,
  reference_time: NOW,
  reference_source: 'registro_no_painel',
  timing: 'sem_limite_configurado',
  minutes_from_start: 100,
  intent: 'pedido_cancelamento',
  intent_source: 'pessoa',
  requested_by: 'paciente',
  recorded_by_user_id: 'u1',
  recorded_by_actor_type: 'user',
  review_status: 'sem_revisao_necessaria',
});

/** Comunicação pelo WhatsApp registrada pela IA: a referência é o carimbo da Meta. */
const whatsappNotice = (k: Ids): Row => ({
  id: k.nw,
  tenant_id: k.t1,
  appointment_id: k.a1,
  patient_id: k.p1,
  channel: 'whatsapp',
  message_id: `wamid.${k.nw}`,
  provider_sent_at: '2026-10-20 09:59:00',
  received_at: '2026-10-20 09:59:30',
  recorded_at: NOW,
  reference_time: '2026-10-20 09:59:00',
  reference_source: 'meta_timestamp',
  timing: 'sem_limite_configurado',
  minutes_from_start: 100,
  intent: 'nao_comparecera',
  intent_source: 'ia',
  recorded_by_user_id: null,
  recorded_by_actor_type: 'ai_agent',
  review_status: 'pendente',
});

/** Abono da falta de a5 (que tem desfecho), com motivo. */
const excuseDecision = (k: Ids): Row => ({
  id: k.d1,
  tenant_id: k.t1,
  appointment_id: k.a5,
  decision: 'falta_abonada',
  reason: 'paciente internado',
  decided_by_user_id: 'u1',
});

/** Nova ocorrência de a4, do mesmo paciente e da mesma clínica. */
const rescheduledAppointment = (k: Ids): Row => ({
  id: k.a6,
  tenant_id: k.t1,
  patient_id: k.p1,
  therapist_id: k.th1,
  scheduled_at: '2026-10-02 12:00:00',
  state: 'Reservada',
  modality: 'presencial',
  updated_at: NOW,
  rescheduled_from_id: k.a4,
});

/** Vínculo da cobrança b1 com a sessão elegível s2, do mesmo paciente. */
const billingLink = (k: Ids): Row => ({ id: k.l1, tenant_id: k.t1, billing_id: k.b1, session_id: k.s2, patient_id: k.p1, created_at: NOW });

/** Duas clínicas, três pacientes, consultas no passado, sessões, uma cobrança e as comunicações que encerram desfechos. */
function seed(k: Ids): string[] {
  const appointment = (id: string, patientId: string, scheduledAt: string, state: string) =>
    insert('appointment', { id, tenant_id: k.t1, patient_id: patientId, therapist_id: k.th1, scheduled_at: scheduledAt, state, modality: 'presencial', updated_at: NOW });
  const closingNotice = (id: string, appointmentId: string, recordedAt: string, timing: string, minutes: number, limitHours: number | null, intent: string) =>
    insert('appointment_notice', {
      ...panelNotice(k),
      id,
      appointment_id: appointmentId,
      recorded_at: recordedAt,
      reference_time: recordedAt,
      timing,
      minutes_from_start: minutes,
      limit_hours_applied: limitHours,
      intent,
    });
  return [
    insert('tenant', { id: k.t1, name: 'Clínica K2-b A', updated_at: NOW }),
    insert('tenant', { id: k.t2, name: 'Clínica K2-b B', updated_at: NOW }),
    insert('patient', { id: k.p1, tenant_id: k.t1, name: 'Paciente 1', phone: '5527990000001', updated_at: NOW }),
    insert('patient', { id: k.p2, tenant_id: k.t1, name: 'Paciente 2', phone: '5527990000002', updated_at: NOW }),
    insert('patient', { id: k.p3, tenant_id: k.t2, name: 'Paciente 3', phone: '5527990000003', updated_at: NOW }),
    insert('therapist', { id: k.th1, tenant_id: k.t1, name: 'Terapeuta A', updated_at: NOW }),
    insert('therapist', { id: k.th2, tenant_id: k.t2, name: 'Terapeuta B', updated_at: NOW }),
    appointment(k.a1, k.p1, '2026-10-01 10:00:00', 'Reservada'),
    appointment(k.a2, k.p2, '2026-10-01 11:00:00', 'Reservada'),
    appointment(k.a4, k.p1, '2026-10-01 12:00:00', 'Cancelada'),
    appointment(k.a5, k.p1, '2026-10-01 13:00:00', 'Reservada'),
    // s1: legada (não elegível, sem kind); s2 e s3: elegíveis, de pacientes diferentes.
    insert('session', { id: k.s1, tenant_id: k.t1, appointment_id: k.a1, patient_id: k.p1, therapist_id: k.th1 }),
    insert('session', { id: k.s2, tenant_id: k.t1, appointment_id: k.a5, patient_id: k.p1, therapist_id: k.th1, kind: 'atendimento', billing_eligibility: 'elegivel' }),
    insert('session', { id: k.s3, tenant_id: k.t1, appointment_id: k.a2, patient_id: k.p2, therapist_id: k.th1, kind: 'atendimento', billing_eligibility: 'elegivel' }),
    insert('billing', {
      id: k.b1,
      tenant_id: k.t1,
      patient_id: k.p1,
      amount: 400,
      status: 'criada',
      due_date: '2026-12-10',
      created_at: NOW,
      updated_at: NOW,
      eligibility_protocol: 'billing-eligibility-v1',
    }),
    closingNotice(k.n1, k.a4, '2026-09-29 10:00:00', 'no_prazo', 1440, 24, 'pedido_cancelamento'),
    closingNotice(k.n2, k.a1, '2026-10-01 10:05:00', 'depois_do_inicio', -5, null, 'atraso'),
    closingNotice(k.n3, k.a1, '2026-10-01 00:00:00', 'fora_do_prazo', 600, 24, 'pedido_remarcacao'),
    closingNotice(k.n4, k.a4, '2026-10-01 12:10:00', 'depois_do_inicio', -10, null, 'nao_comparecera'),
    // a5 já tem desfecho: é sobre ele que as decisões são gravadas.
    insert('appointment_outcome', { ...noShowOutcome(k), appointment_id: k.a5, scheduled_at_at_outcome: '2026-10-01 13:00:00' }),
  ];
}

type Attempt = [label: string, sql: (k: Ids) => string];

const outcomeAttempt = (label: string, base: (k: Ids) => Row, change: (k: Ids) => Row = () => ({})): Attempt => [
  label,
  (k) => insert('appointment_outcome', { ...base(k), ...change(k) }),
];
const noticeAttempt = (label: string, base: (k: Ids) => Row, change: (k: Ids) => Row = () => ({})): Attempt => [
  label,
  (k) => insert('appointment_notice', { ...base(k), ...change(k) }),
];
const decisionAttempt = (label: string, change: (k: Ids) => Row = () => ({})): Attempt => [
  label,
  (k) => insert('appointment_decision', { ...excuseDecision(k), ...change(k) }),
];
const linkAttempt = (label: string, change: (k: Ids) => Row = () => ({})): Attempt => [
  label,
  (k) => insert('billing_session', { ...billingLink(k), ...change(k) }),
];
const sessionAttempt = (label: string, session: 's1' | 's2', set: Row): Attempt => [label, (k) => update('session', k[session], set)];

const NO_SHOW = outcomeAttempt('desfecho Falta', noShowOutcome);
const LATE_NOTICE = outcomeAttempt('desfecho AvisoTardio com a comunicação depois do início', lateNoticeOutcome);
const CANCELLED = outcomeAttempt('desfecho Cancelada com a comunicação no prazo', cancelledOutcome);
const PANEL = noticeAttempt('comunicação pelo painel', panelNotice);
const WHATSAPP = noticeAttempt('comunicação pelo WhatsApp, com o carimbo da Meta', whatsappNotice);
const EXCUSE = decisionAttempt('abono com motivo');
const LINK = linkAttempt('vínculo com sessão elegível do mesmo paciente');

const CASES: Record<K2bConstraint, { controls: Attempt[]; violations: Attempt[] }> = {
  appointment_outcome_freeze_fkey: {
    controls: [NO_SHOW],
    violations: [
      outcomeAttempt('retrato com horário diferente do da consulta', noShowOutcome, () => ({ scheduled_at_at_outcome: '2026-10-01 10:30:00' })),
      outcomeAttempt('retrato com estado diferente do da consulta', noShowOutcome, () => ({ state_at_outcome: 'Confirmada' })),
      outcomeAttempt('retrato com modalidade diferente', noShowOutcome, () => ({ modality_at_outcome: 'online' })),
      outcomeAttempt('desfecho gravado em outra clínica', noShowOutcome, (k) => ({ tenant_id: k.t2 })),
    ],
  },
  appointment_outcome_state_check: {
    controls: [NO_SHOW, CANCELLED],
    violations: [
      outcomeAttempt('Remarcada com a consulta ainda aberta', noShowOutcome, (k) => ({
        outcome: 'Remarcada',
        no_show_decision: null,
        closing_notice_id: k.n3,
        closing_notice_timing: 'fora_do_prazo',
      })),
      outcomeAttempt('Realizada numa consulta cancelada', cancelledOutcome, () => ({ outcome: 'Realizada', closing_notice_id: null, closing_notice_timing: null })),
    ],
  },
  appointment_outcome_no_show_decision_check: {
    controls: [NO_SHOW],
    violations: [
      outcomeAttempt('Falta sem decisão de cobrança', noShowOutcome, () => ({ no_show_decision: null })),
      outcomeAttempt('Realizada com decisão de falta', noShowOutcome, () => ({ outcome: 'Realizada' })),
    ],
  },
  appointment_outcome_no_show_decided_check: {
    controls: [
      NO_SHOW,
      outcomeAttempt('cobrança da falta confirmada com data e autor', noShowOutcome, () => ({
        no_show_decision: 'cobranca_confirmada',
        no_show_decision_at: NOW,
        no_show_decision_by_user_id: 'u1',
      })),
    ],
    violations: [
      outcomeAttempt('cobrança da falta confirmada sem data nem autor', noShowOutcome, () => ({ no_show_decision: 'cobranca_confirmada' })),
      outcomeAttempt('falta aguardando decisão, mas com autor', noShowOutcome, () => ({ no_show_decision_by_user_id: 'u1' })),
    ],
  },
  appointment_outcome_late_notice_decision_check: {
    controls: [LATE_NOTICE],
    violations: [outcomeAttempt('Falta com decisão de aviso tardio', noShowOutcome, () => ({ late_notice_decision: 'aguardando_decisao' }))],
  },
  appointment_outcome_late_notice_decided_check: {
    controls: [
      LATE_NOTICE,
      outcomeAttempt('aviso tardio sem cobrança, decidido com data e autor', lateNoticeOutcome, () => ({
        late_notice_decision: 'sem_cobranca',
        late_notice_decision_at: NOW,
        late_notice_decision_by_user_id: 'u1',
      })),
    ],
    violations: [
      outcomeAttempt('aviso tardio sem cobrança, sem data nem autor', lateNoticeOutcome, () => ({ late_notice_decision: 'sem_cobranca' })),
      outcomeAttempt('aviso tardio aguardando decisão, mas com data', lateNoticeOutcome, () => ({ late_notice_decision_at: NOW })),
    ],
  },
  appointment_outcome_closing_notice_check: {
    controls: [LATE_NOTICE, CANCELLED],
    violations: [
      outcomeAttempt('AvisoTardio sem comunicação', lateNoticeOutcome, () => ({ closing_notice_id: null, closing_notice_timing: null })),
      outcomeAttempt('Falta com comunicação de encerramento', noShowOutcome, (k) => ({ closing_notice_id: k.n3, closing_notice_timing: 'fora_do_prazo' })),
      outcomeAttempt('comunicação sem a classificação', lateNoticeOutcome, () => ({ closing_notice_timing: null })),
    ],
  },
  appointment_outcome_closing_timing_check: {
    controls: [LATE_NOTICE, CANCELLED],
    violations: [
      outcomeAttempt('AvisoTardio com comunicação fora do prazo (antes do início)', lateNoticeOutcome, (k) => ({
        closing_notice_id: k.n3,
        closing_notice_timing: 'fora_do_prazo',
      })),
      outcomeAttempt('Cancelada com comunicação depois do início', cancelledOutcome, (k) => ({ closing_notice_id: k.n4, closing_notice_timing: 'depois_do_inicio' })),
    ],
  },
  appointment_outcome_closing_notice_fkey: {
    controls: [CANCELLED],
    violations: [
      outcomeAttempt('comunicação de outra consulta', cancelledOutcome, (k) => ({ closing_notice_id: k.n3, closing_notice_timing: 'fora_do_prazo' })),
      outcomeAttempt('classificação diferente da gravada na comunicação', cancelledOutcome, () => ({ closing_notice_timing: 'fora_do_prazo' })),
    ],
  },
  appointment_notice_actor_check: {
    controls: [PANEL, WHATSAPP],
    violations: [
      noticeAttempt('registrada por pessoa sem o usuário', panelNotice, () => ({ recorded_by_user_id: null })),
      noticeAttempt('registrada pela IA com usuário', whatsappNotice, () => ({ recorded_by_user_id: 'u1' })),
    ],
  },
  appointment_notice_reference_check: {
    controls: [
      PANEL,
      WHATSAPP,
      noticeAttempt('comunicação pelo WhatsApp, com o recebimento no webhook', whatsappNotice, () => ({
        reference_source: 'recebimento_webhook',
        reference_time: '2026-10-20 09:59:30',
      })),
    ],
    violations: [
      noticeAttempt('painel com o horário alegado no lugar do registro', panelNotice, () => ({ reference_time: '2026-10-20 08:00:00' })),
      noticeAttempt('painel com o carimbo da Meta como fonte', panelNotice, () => ({ reference_source: 'meta_timestamp' })),
      noticeAttempt('painel com message_id', panelNotice, (k) => ({ message_id: `wamid.${k.nx}` })),
      noticeAttempt('WhatsApp sem o recebimento', whatsappNotice, () => ({ received_at: null })),
      noticeAttempt('WhatsApp com referência diferente do carimbo da Meta', whatsappNotice, () => ({ reference_time: '2026-10-20 09:00:00' })),
      noticeAttempt('WhatsApp com o registro no painel como fonte', whatsappNotice, () => ({ reference_source: 'registro_no_painel' })),
    ],
  },
  appointment_notice_timing_check: {
    controls: [PANEL, noticeAttempt('depois do início com minutos ≤ 0', panelNotice, () => ({ timing: 'depois_do_inicio', minutes_from_start: -5 }))],
    violations: [
      noticeAttempt('depois do início com minutos positivos', panelNotice, () => ({ timing: 'depois_do_inicio', minutes_from_start: 10 })),
      noticeAttempt('antes do início com minutos negativos', panelNotice, () => ({ minutes_from_start: -5 })),
    ],
  },
  appointment_notice_limit_check: {
    controls: [PANEL, noticeAttempt('no prazo com o limite aplicado', panelNotice, () => ({ timing: 'no_prazo', limit_hours_applied: 24 }))],
    violations: [
      noticeAttempt('no prazo sem o limite aplicado', panelNotice, () => ({ timing: 'no_prazo' })),
      noticeAttempt('sem limite configurado, mas com limite', panelNotice, () => ({ limit_hours_applied: 24 })),
    ],
  },
  appointment_notice_review_check: {
    controls: [
      WHATSAPP,
      noticeAttempt('revisada com data e revisor', panelNotice, () => ({ review_status: 'revisada', reviewed_at: NOW, reviewed_by_user_id: 'u2' })),
    ],
    violations: [
      noticeAttempt('revisada sem data nem revisor', panelNotice, () => ({ review_status: 'revisada' })),
      noticeAttempt('pendente com revisor', whatsappNotice, () => ({ reviewed_by_user_id: 'u2' })),
    ],
  },
  appointment_notice_appointment_fkey: {
    controls: [PANEL],
    violations: [
      noticeAttempt('comunicação com paciente que não é o da consulta', panelNotice, (k) => ({ patient_id: k.p2 })),
      noticeAttempt('comunicação de outra clínica para a consulta', panelNotice, (k) => ({ tenant_id: k.t2, patient_id: k.p3 })),
    ],
  },
  appointment_decision_reason_check: {
    controls: [EXCUSE, decisionAttempt('cobrança da falta confirmada sem motivo', () => ({ decision: 'cobranca_de_falta_confirmada', reason: null }))],
    violations: [
      decisionAttempt('abono sem motivo', () => ({ reason: null })),
      decisionAttempt('abono com motivo em branco', () => ({ reason: '   ' })),
      decisionAttempt('reversão do abono com motivo vazio', () => ({ decision: 'abono_revertido', reason: '' })),
    ],
  },
  appointment_decision_outcome_fkey: {
    controls: [EXCUSE],
    violations: [
      decisionAttempt('decisão sobre consulta sem desfecho', (k) => ({ appointment_id: k.a2 })),
      decisionAttempt('decisão gravada em outra clínica', (k) => ({ tenant_id: k.t2 })),
    ],
  },
  appointment_rescheduled_from_fkey: {
    controls: [['remarcação ligada à anterior do mesmo paciente', (k) => insert('appointment', rescheduledAppointment(k))]],
    violations: [
      ['remarcação ligada à consulta de outro paciente', (k) => insert('appointment', { ...rescheduledAppointment(k), patient_id: k.p2 })],
      [
        'remarcação ligada à consulta de outra clínica',
        (k) => insert('appointment', { ...rescheduledAppointment(k), id: k.a7, tenant_id: k.t2, patient_id: k.p3, therapist_id: k.th2 }),
      ],
    ],
  },
  session_void_check: {
    controls: [sessionAttempt('anular a sessão com motivo', 's1', { voided_at: NOW, void_reason: 'desfecho_corrigido' })],
    violations: [
      sessionAttempt('sessão anulada sem motivo', 's1', { voided_at: NOW }),
      sessionAttempt('motivo de anulação sem anulação', 's1', { void_reason: 'desfecho_corrigido' }),
    ],
  },
  session_billing_eligibility_check: {
    controls: [sessionAttempt('sessão passa a elegível com kind', 's1', { billing_eligibility: 'elegivel', kind: 'atendimento' })],
    violations: [
      sessionAttempt('sessão elegível sem kind', 's1', { billing_eligibility: 'elegivel' }),
      sessionAttempt('sessão elegível anulada', 's2', { voided_at: NOW, void_reason: 'desfecho_corrigido' }),
    ],
  },
  billing_session_required_eligibility_check: {
    controls: [LINK],
    violations: [linkAttempt('vínculo exigindo sessão não elegível', () => ({ required_eligibility: 'nao_elegivel' }))],
  },
  billing_session_legacy_or_eligibility_check: {
    controls: [LINK],
    violations: [linkAttempt('vínculo novo sem a elegibilidade exigida', () => ({ required_eligibility: null }))],
  },
  billing_session_session_eligibility_fkey: {
    controls: [LINK],
    violations: [linkAttempt('vínculo com sessão não elegível do mesmo paciente', (k) => ({ session_id: k.s1 }))],
  },
};

/**
 * Uma tentativa numa subtransação: a instrução é sempre desfeita (se for
 * aceita, o bloco levanta P0999 de propósito) e o resultado fica na tabela
 * temporária.
 */
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
    INSERT INTO "k2b_attempt" VALUES (${n}, failed_state, NULLIF(failed_constraint, ''));
  END $attempt$`;

class ScenarioRolledBack extends Error {}

/** Monta um cenário novo, roda as tentativas e desfaz tudo; devolve [rótulo, resultado] de cada uma, na ordem. */
async function attemptAll(attempts: Attempt[]): Promise<Array<[string, string]>> {
  const k = scenarioIds();
  type AttemptRow = { n: number; sqlstate: string; constraint_name: string | null };
  let rows: AttemptRow[] = [];
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE "k2b_attempt" ("n" int PRIMARY KEY, "sqlstate" text NOT NULL, "constraint_name" text) ON COMMIT DROP`);
        for (const sql of seed(k)) await tx.$executeRawUnsafe(sql);
        for (const [n, [, sql]] of attempts.entries()) await tx.$executeRawUnsafe(attemptBlock(n, sql(k)));
        rows = await tx.$queryRawUnsafe<AttemptRow[]>(`SELECT "n", "sqlstate", "constraint_name" FROM "k2b_attempt" ORDER BY "n"`);
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

describe('[CRÍTICO — K2-b] cada restrição do banco recusa a linha que a viola, pelo próprio nome', () => {
  it('as 23 restrições da K2-b têm casos, cada uma com controle e violação', () => {
    expect(Object.keys(CASES).sort()).toEqual([...K2B_CONSTRAINTS].sort());
    for (const [constraint, { controls, violations }] of Object.entries(CASES)) {
      expect(controls.length, constraint).toBeGreaterThan(0);
      expect(violations.length, constraint).toBeGreaterThan(0);
    }
  });

  it.each(K2B_CONSTRAINTS)('%s', async (constraint) => {
    const { controls, violations } = CASES[constraint];
    const refused = `recusada por ${constraint} (${constraint.endsWith('_fkey') ? '23503' : '23514'})`;
    expect(await attemptAll([...controls, ...violations])).toEqual([
      ...controls.map(([label]) => [label, 'aceita']),
      ...violations.map(([label]) => [label, refused]),
    ]);
  });

  it('nada dos cenários fica gravado', async () => {
    expect(await db.tenant.count({ where: { id: { startsWith: 'k2bc-' } } })).toBe(0);
  });
});
