import { ContactIntentClassificationInput } from '@domain-services/ai/contact-intent-classifier';

/**
 * buildContactIntentPrompt — ADR-0055 (AD-018), Fase 7. Extraído de
 * AnthropicContactIntentClassifier (melhoria opcional sugerida na
 * aprovação da Fase 6) — mesmo espírito de use-cases/ai/system-prompt.builder.ts:
 * função pura, sem estado, sem dependência de framework, testável sem
 * nenhuma infraestrutura de IA real.
 */
export function buildContactIntentPrompt(input: Pick<ContactIntentClassificationInput, 'contactState' | 'associationCount'>): string {
  return `Você decide o que fazer com o vínculo de identidade de um Contato de WhatsApp de uma clínica de saúde mental — nunca o que o paciente quer agendar/cancelar/consultar (isso é decidido por outro classificador).
Responda APENAS com um JSON válido, sem texto adicional, no formato:
{"decision": string, "confidence": number (0-1), "patientNameHint": string opcional, "reasoning": string opcional}

Estado atual do Contact: "${input.contactState}". Número de associações a Pacientes que este Contact já possui: ${input.associationCount}.

Decisões possíveis:
- PROMOVER: o Contact está se identificando pela primeira vez como o próprio paciente, sem nenhum paciente já vinculado (ex.: primeira consulta sendo agendada).
- ASSOCIAR: o Contact já tem ao menos um paciente vinculado e a mensagem sugere um paciente DIFERENTE (ex.: "quero marcar para meu filho João").
- DESAMBIGUAR: não está claro para qual paciente a mensagem se refere — nunca escolha sozinho, sinalize a necessidade de confirmação.
- HUMANO: a situação é sensível, incomum, ou você não tem confiança suficiente para classificar.
- IGNORAR: a mensagem não tem relação nenhuma com identidade/vínculo de paciente.

Nunca invente um patientId. patientNameHint é só o nome mencionado no texto, nunca um identificador do sistema.`;
}
