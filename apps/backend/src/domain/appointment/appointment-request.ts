import type { Appointment } from './appointment.entity';
import type { AppointmentNotice } from './appointment-notice';
import type { AppointmentOutcomeRecord } from './appointment-outcome';

/**
 * Pedido de cancelamento ou remarcação feito pelo WhatsApp — K11 (ADR-0069,
 * decisões D2, D4 e D6 de 23/10/2026).
 *
 * O pedido e cada resposta do paciente são comunicações distintas, somente
 * acréscimo. O estado do pedido não é gravado em lugar nenhum: é derivado
 * delas, da consulta e do desfecho, sempre que alguém precisa dele — quando
 * chega uma mensagem na conversa e quando a equipe consulta as pendências.
 * Por isso um pedido "vence" sem agendador (D6): basta o horário da consulta
 * ter chegado sem resposta.
 */
export type AppointmentRequestStatus =
  /** Esperando a resposta do paciente, antes do início. */
  | 'aguardando'
  /** O paciente confirmou e o desfecho foi registrado pela IA. */
  | 'confirmado'
  /** O paciente respondeu que não quer; a consulta continua como estava. */
  | 'recusado'
  /** A resposta não foi uma confirmação clara: ficou com a equipe. */
  | 'encaminhado'
  /** O paciente confirmou, mas nada foi executado (confirmação tardia, consulta mudada, horário ocupado): ficou com a equipe. */
  | 'nao_executado'
  /** O início chegou sem resposta: nada foi executado. */
  | 'vencido'
  /** Um pedido mais novo na mesma conversa o substituiu. */
  | 'substituido'
  /** A consulta mudou ou foi encerrada por outro caminho antes da resposta. */
  | 'sem_efeito';

/** Estados que pedem a atenção da equipe ou ainda esperam o paciente — a lista de pendências do painel. */
export const PENDING_REQUEST_STATUSES: readonly AppointmentRequestStatus[] = ['aguardando', 'vencido', 'encaminhado', 'nao_executado'];

export interface AppointmentRequestView {
  request: AppointmentNotice;
  /** Respostas a este pedido, da mais antiga para a mais nova. */
  replies: AppointmentNotice[];
  status: AppointmentRequestStatus;
}

export interface RequestFacts {
  request: AppointmentNotice;
  replies: AppointmentNotice[];
  /** A consulta como está agora (null se não for mais legível). */
  appointment: Appointment | null;
  outcome: AppointmentOutcomeRecord | null;
  /** Há um pedido mais novo na mesma conversa. */
  superseded: boolean;
  now: Date;
}

export function deriveRequestStatus(facts: RequestFacts): AppointmentRequestStatus {
  const { request, replies, appointment, outcome } = facts;
  if (outcome && outcome.closingNoticeId === request.id && outcome.recordedByActorType === 'ai_agent') {
    return 'confirmado';
  }
  const last = replies[replies.length - 1];
  if (last) {
    if (last.confirmationAnswer === 'recusa') return 'recusado';
    if (last.confirmationAnswer === 'ambigua') return 'encaminhado';
    return 'nao_executado';
  }
  if (facts.superseded) return 'substituido';
  if (!appointment || outcome || !appointment.isOpen || !request.stillDescribes(appointment)) return 'sem_efeito';
  if (appointment.hasStarted(facts.now)) return 'vencido';
  return 'aguardando';
}
