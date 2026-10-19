/**
 * Respostas reais do claude-haiku-4-5-20251001 no teste contra a API de
 * 19/10/2026 (test/manual/anthropic-smoke.test.ts, conteúdo sintético),
 * copiadas sem mudar nada. O modelo pôs o JSON entre cercas de código nas
 * duas chamadas que esperam JSON.
 */
const FENCE = '```';

export const REAL_INTENT_RESPONSE = [
  `${FENCE}json`,
  '{',
  '  "intent": "consultar_disponibilidade",',
  '  "confidence": 0.95,',
  '  "entities": {',
  '    "dia_semana": "quinta-feira",',
  '    "periodo": "tarde"',
  '  },',
  '  "requiresEscalation": false',
  '}',
  FENCE,
].join('\n');

export const REAL_CONTACT_INTENT_RESPONSE = [
  `${FENCE}json`,
  '{',
  '  "decision": "PROMOVER",',
  '  "confidence": 0.85,',
  '  "patientNameHint": null,',
  '  "explicitConfirmation": false,',
  '  "reasoning": "A pessoa está consultando disponibilidade de horários, demonstrando interesse em agendar atendimento. Não há indicação de ser paciente existente da clínica. Trata-se de um novo contato buscando informações sobre agendamento, característico de uma possível promoção/cadastro. Porém, o nome completo não foi fornecido nesta mensagem, então patientNameHint permanece nulo."',
  '}',
  FENCE,
].join('\n');
