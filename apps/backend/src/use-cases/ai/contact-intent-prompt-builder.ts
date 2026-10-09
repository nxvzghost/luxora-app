import { ContactIntentClassificationInput } from '@domain-services/ai/contact-intent-classifier';

/**
 * buildContactIntentPrompt — ADR-0055 (AD-018), Fase 7. Extraído de
 * AnthropicContactIntentClassifier (melhoria opcional sugerida na
 * aprovação da Fase 6) — mesmo espírito de use-cases/ai/system-prompt.builder.ts:
 * função pura, sem estado, sem dependência de framework, testável sem
 * nenhuma infraestrutura de IA real.
 *
 * ADR-0063 (AD-037 e AD-038) — o classificador só SINALIZA. Ele devolve o
 * nome completo que a pessoa informou e se a mensagem confirma, com todas
 * as letras, o que foi perguntado; quem decide cadastrar, pedir confirmação
 * ou entregar a conversa à clínica é o backend, com regras fixas. Este
 * texto ainda não foi exercitado contra o modelo real (Tarefa 03).
 */
export function buildContactIntentPrompt(input: Pick<ContactIntentClassificationInput, 'contactState' | 'associationCount'>): string {
  return `Você decide o que fazer com o vínculo de identidade de um Contato de WhatsApp de uma clínica de saúde mental — nunca o que o paciente quer agendar/cancelar/consultar (isso é decidido por outro classificador).
Responda APENAS com um JSON válido, sem texto adicional, no formato:
{"decision": string, "confidence": number (0-1), "patientNameHint": string opcional, "explicitConfirmation": boolean opcional, "reasoning": string opcional}

Estado atual do Contact: "${input.contactState}". Número de associações a Pacientes que este Contact já possui: ${input.associationCount}.

Decisões possíveis:
- PROMOVER: a pessoa ainda não é paciente da clínica e quer ser atendida ou se cadastrar. Quando ela informar o PRÓPRIO nome completo, devolva-o em patientNameHint, exatamente como foi escrito.
- ASSOCIAR: a mensagem trata de um paciente que JÁ é da clínica e que este número não identifica sozinho — outra pessoa (ex.: "quero marcar para meu filho João") ou a própria pessoa dizendo que já é paciente e está em um número novo (ex.: "troquei de número").
- DESAMBIGUAR: não está claro para qual paciente a mensagem se refere — nunca escolha sozinho, sinalize a necessidade de confirmação.
- HUMANO: a situação é sensível, incomum, ou você não tem confiança suficiente para classificar.
- IGNORAR: a mensagem não tem relação nenhuma com identidade/vínculo de paciente.

explicitConfirmation: true SOMENTE quando a mensagem atual confirma de forma explícita e inequívoca (ex.: "sim, confirmo", "isso mesmo, pode cadastrar") o nome e o cadastro que o assistente pediu para confirmar na mensagem anterior. Em qualquer outro caso — dúvida, resposta vaga, nome diferente, mensagem sobre outro assunto — use false.

Nunca invente um patientId. patientNameHint é só o nome escrito no texto, nunca um identificador do sistema. Nunca use o nome de perfil do WhatsApp nem um nome que a pessoa não escreveu nesta conversa.`;
}
