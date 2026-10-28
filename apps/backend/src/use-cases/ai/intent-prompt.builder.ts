import { AppointmentContextForAi, ConfirmationClassification } from '@domain-services/ai/ai-provider';

export const CONFIRMATION_VALUES: readonly ConfirmationClassification[] = ['confirma', 'recusa', 'ambigua', 'nao_relacionada'];

/**
 * Instrução de interpretIntent (Módulo 12).
 *
 * K11 (D3, D4, D7) — para o paciente identificado, a instrução leva as
 * consultas futuras dele sem nenhum identificador (data, dia da semana,
 * horário, profissional, modalidade) e, quando houver, a pergunta de
 * confirmação ainda sem resposta. A IA só extrai do texto de qual consulta
 * se trata e classifica a resposta; quem localiza a consulta, confere as
 * condições e decide se algo acontece é o backend. Sem nome, telefone ou id
 * de paciente (A-14).
 */
export function buildIntentPrompt(context?: AppointmentContextForAi): string {
  const base = `Você identifica a intenção de mensagens de pacientes para uma clínica ou consultório.
Responda APENAS com um JSON válido, sem texto adicional, no formato:
{"intent": string, "confidence": number (0-1), "entities": object, "requiresEscalation": boolean, "escalationReason": string opcional, "confirmation": string opcional}

Intents possíveis: agendar_consulta, remarcar_consulta, cancelar_consulta, nao_comparecer, confirmar_presenca, consultar_cobranca, consultar_disponibilidade, enviar_comprovante, duvida_geral, outro.
- nao_comparecer: o paciente avisa que não vai conseguir ir a uma consulta (sem pedir outro horário).
- cancelar_consulta, remarcar_consulta e nao_comparecer: em "entities", informe o que o paciente disse sobre a consulta, quando disser: "appointmentDate" (AAAA-MM-DD), "appointmentTime" (HH:MM) e "professional" (nome). Em remarcar_consulta, informe também o horário novo pedido: "newDate" (AAAA-MM-DD) e "newTime" (HH:MM). Nunca invente data, horário ou profissional que o paciente não indicou.

Critério de escalonamento: requiresEscalation=true quando a mensagem envolver algo emocionalmente delicado, ambíguo, ou qualquer situação que fuja do administrativo linear (agendar/cancelar/confirmar/consultar sem conflito).`;

  if (!context) return base;

  const consultas = context.upcoming.length
    ? context.upcoming.map((a) => `- ${a.date} (${a.weekday}) às ${a.time}, com ${a.professional}, ${a.modality}`).join('\n')
    : '- nenhuma consulta futura';
  let prompt = `${base}

Hoje, no fuso da clínica: ${context.today}.
Consultas futuras do paciente (use só para entender de qual consulta ele fala):
${consultas}`;

  if (context.pendingQuestion) {
    prompt += `

O paciente ainda não respondeu a esta pergunta, enviada pela clínica: "${context.pendingQuestion}"
Em "confirmation", classifique a mensagem atual em relação a ela:
- "confirma": confirma de forma clara e sem condição o que a pergunta propõe (por exemplo "sim", "pode cancelar", "confirmo");
- "recusa": diz que não quer (por exemplo "não", "deixa como está", "desisti");
- "ambigua": responde à pergunta, mas sem clareza, com dúvida ou com condição (por exemplo "sim, mas…", "acho que sim", "ok?");
- "nao_relacionada": a mensagem trata de outro assunto e não responde à pergunta (inclusive um pedido novo, sobre outra consulta ou com outra ação, que substitui o anterior).
Sempre informe "confirmation" quando houver esta pergunta.`;
  }
  return prompt;
}
