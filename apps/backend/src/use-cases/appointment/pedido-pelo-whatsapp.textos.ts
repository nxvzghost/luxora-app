/**
 * Textos do pedido de cancelamento ou remarcação pelo WhatsApp — K11
 * (ADR-0069; decisões D3, D4 e D8 de 23/10/2026).
 *
 * São montados pelo backend, com os dados da consulta lidos do banco, e
 * enviados ao paciente como estão: a IA não escreve a pergunta de
 * confirmação nem o resultado. Nenhum texto fala em cobrança (D8): a
 * consequência de um cancelamento fora do prazo é decisão humana.
 */

export interface AppointmentDescription {
  /** "terça-feira, 28/10, às 14:00, com Dra. Paula Souza" (", online" quando for). */
  text: string;
}

/** Data, horário e profissional no fuso da clínica. */
export function describeAppointment(when: Date, professional: string, modality: string, timeZone: string): AppointmentDescription {
  const weekday = when.toLocaleDateString('pt-BR', { weekday: 'long', timeZone });
  const day = when.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone });
  const time = when.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone });
  return { text: `${weekday}, ${day}, às ${time}, com ${professional}${modality === 'online' ? ', online' : ''}` };
}

/** Só a data e o horário (o horário novo de uma remarcação: mesmo profissional e modalidade). */
export function describeSlot(when: Date, timeZone: string): string {
  const weekday = when.toLocaleDateString('pt-BR', { weekday: 'long', timeZone });
  const day = when.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone });
  const time = when.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone });
  return `${weekday}, ${day}, às ${time}`;
}

export const K11_TEXT = {
  askCancel: (a: AppointmentDescription) =>
    `Para confirmar: você quer cancelar a consulta de ${a.text}? Responda "sim" para cancelar ou "não" para manter a consulta.`,
  askReschedule: (a: AppointmentDescription, newSlot: string) =>
    `Para confirmar: você quer remarcar a consulta de ${a.text} para ${newSlot}? Responda "sim" para remarcar ou "não" para manter o horário atual.`,
  cancelled: (a: AppointmentDescription) => `Pronto: a consulta de ${a.text} foi cancelada.`,
  rescheduled: (newSlot: string, previous: AppointmentDescription) =>
    `Pronto: sua consulta foi remarcada para ${newSlot}. O horário de ${previous.text} foi liberado.`,
  kept: (a: AppointmentDescription) => `Tudo bem, a consulta de ${a.text} continua marcada.`,
  unclear: () => 'Não consegui entender se você confirma. A equipe da clínica vai continuar o atendimento por aqui.',
  tooLate: () =>
    'O horário dessa consulta já começou, então não consigo mais alterá-la por aqui. A equipe da clínica vai continuar o atendimento.',
  changed: () =>
    'Essa consulta foi alterada depois da minha pergunta, então não fiz nenhuma mudança. A equipe da clínica vai continuar o atendimento.',
  slotTakenAtConfirmation: (newSlot: string, current: AppointmentDescription) =>
    `O horário de ${newSlot} não está mais disponível, então sua consulta continua em ${current.text}. A equipe da clínica vai ajudar a escolher outro horário.`,
  noAppointment: () => 'Não encontrei nenhuma consulta futura no seu nome. Se precisar, a equipe da clínica pode ajudar.',
  notMatched: (list: string) => `Não encontrei uma consulta sua com esses dados. Suas próximas consultas são: ${list}. De qual delas você está falando?`,
  severalMatches: (list: string) => `Você tem mais de uma consulta: ${list}. De qual delas você está falando?`,
  askNewSlot: (a: AppointmentDescription) => `Para qual dia e horário você quer remarcar a consulta de ${a.text}?`,
  newSlotUnavailable: (newSlot: string) => `O horário de ${newSlot} não está disponível. Quer tentar outro dia ou horário?`,
  newSlotInThePast: () => 'Esse horário já passou. Para qual dia e horário você quer remarcar?',
  alreadyStarted: (a: AppointmentDescription) =>
    `A consulta de ${a.text} já começou, então não consigo alterá-la por aqui. A equipe da clínica vai continuar o atendimento.`,
  /** Identidade mudou com um pedido pendente: nenhum dado de consulta nem de paciente (ADR-0063). */
  handedToTeam: () => 'A equipe da clínica vai continuar o atendimento por aqui.',
} as const;

/** Por que um pedido foi para a equipe — o aviso interno do painel. */
export type TeamReason =
  | 'recusa'
  | 'ambigua'
  | 'tardia'
  | 'vencido'
  | 'consulta_alterada'
  | 'horario_indisponivel'
  | 'depois_do_inicio'
  | 'identidade_alterada';

const WHAT: Record<'cancelar' | 'remarcar', string> = { cancelar: 'cancelamento', remarcar: 'remarcação' };

export const TEAM_NOTICE: Record<TeamReason, { title: string; message: (subject: string, action: 'cancelar' | 'remarcar') => string }> = {
  recusa: {
    title: 'WhatsApp: paciente desistiu do pedido',
    message: (s, action) => `O paciente desistiu do pedido de ${WHAT[action]} da consulta de ${s}. A consulta continua como estava.`,
  },
  ambigua: {
    title: 'WhatsApp: resposta sem confirmação clara',
    message: (s, action) =>
      `O paciente respondeu à pergunta sobre o pedido de ${WHAT[action]} da consulta de ${s}, mas sem confirmar com clareza. Nada foi alterado; a conversa precisa de atendimento humano.`,
  },
  tardia: {
    title: 'WhatsApp: confirmação depois do início',
    message: (s, action) =>
      `O paciente confirmou o pedido de ${WHAT[action]} da consulta de ${s} depois do horário de início. Nada foi alterado automaticamente; o desfecho da consulta é decisão da equipe.`,
  },
  vencido: {
    title: 'WhatsApp: pedido sem confirmação até o início',
    message: (s, action) =>
      `O pedido de ${WHAT[action]} da consulta de ${s} não foi confirmado pelo paciente até o horário de início. Nada foi alterado automaticamente; o desfecho da consulta é decisão da equipe.`,
  },
  consulta_alterada: {
    title: 'WhatsApp: consulta mudou antes da confirmação',
    message: (s, action) =>
      `O paciente respondeu à pergunta sobre o pedido de ${WHAT[action]} da consulta de ${s}, mas a consulta foi alterada depois da pergunta. Nada foi executado; confira com o paciente.`,
  },
  horario_indisponivel: {
    title: 'WhatsApp: horário novo ocupado na confirmação',
    message: (s) =>
      `O paciente confirmou a remarcação da consulta de ${s}, mas o horário novo foi ocupado antes da confirmação. A consulta não foi alterada; ajude o paciente a escolher outro horário.`,
  },
  depois_do_inicio: {
    title: 'WhatsApp: aviso depois do início da consulta',
    message: (s, action) =>
      `O paciente pediu pelo WhatsApp ${action === 'remarcar' ? 'a remarcação' : 'o cancelamento'} da consulta de ${s} quando ela já tinha começado. Nada foi alterado automaticamente; o desfecho da consulta é decisão da equipe.`,
  },
  identidade_alterada: {
    title: 'WhatsApp: pedido pendente com identidade que mudou',
    message: (s, action) =>
      `Há um pedido de ${WHAT[action]} da consulta de ${s} aguardando confirmação, mas o número da conversa não identifica mais o mesmo paciente. Nada foi alterado; a conversa precisa de atendimento humano.`,
  },
};
