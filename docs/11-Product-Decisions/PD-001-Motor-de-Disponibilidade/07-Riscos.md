# PD-001 — Riscos

## Riscos técnicos

### 1. Regressão nos fluxos que já funcionam
`AgendarConsultaUseCase`, `RemarcarConsultaUseCase` e `CriarAgendamentoRecorrenteUseCase` têm testes existentes que passam hoje. Mudar o comportamento pra consultar o Motor antes de agir corre risco real de quebrar caso de borda já coberto — mitigação: rodar a suíte existente a cada mudança da Fase 1, nunca só os testes novos.

### 2. Latência adicional em toda escrita de agenda
Consultar o Motor antes de cada escrita adiciona uma chamada a mais no caminho crítico. Irrelevante para o volume de uma clínica, mas é mudança de perfil de performance que vale medir, não assumir.

### 3. Migração de dado real, se já existir
Se já existir alguma clínica real com `Therapist.availability` populado no momento da implementação, a migração pra `AvailabilityCalendar` precisa preservar esse dado sem perda.

### 4. Detecção de recorrência por heurística (Fase 4) pode errar
"Mesmo paciente, mesmo horário, intervalo constante → sugere recorrência" é heurística, não certeza. Mitigação já embutida no plano: nunca criar `RecurringBlock` automaticamente sem confirmação humana.

### 5. OAuth do Google Calendar é complexidade real
Token expira, precisa refresh, escopo mínimo necessário, revogação a qualquer momento — superfície de erro maior que Asaas/WhatsApp. Vale tratar como seu próprio sub-projeto dentro da Fase 4.

## Riscos de produto (o PD-001 não menciona, mas valem ser ditos)

### 6. Monitoramento proativo da IA pode virar spam
Sem limite de frequência claro, "iniciar conversa automaticamente" vira exatamente o tipo de notificação que faz terapeuta silenciar o número da clínica. Recomendo definir uma régua de frequência máxima antes de implementar — mesmo cuidado já aplicado à régua de inadimplência (Módulo 13).

### 7. Duração de sessão continua sendo só por Clínica, não por tipo de atendimento
O PD-001 pede "duração padrão da consulta" por dia da semana — mas hoje `defaultSessionDurationMinutes` é um valor único por Clínica inteira. Se a intenção é duração diferente por terapeuta ou tipo de consulta, isso não está coberto nem pelo estado atual nem pelo plano de 4 fases — vale confirmar antes da Fase 1, porque muda o formato de `AvailabilityWindow`.

### 8. Escopo grande o bastante para nunca "acabar"
Risco real: se cada fase não tiver critério de "pronto" e aprovação própria, o projeto corre risco de nunca ter uma versão utilizável. O plano faseado existe pra mitigar isso.

## Risco já mitigado por decisão anterior, vale reforçar

"Nenhum módulo acessa a agenda diretamente" é o mesmo tipo de regra que o ADR-0021 já estabeleceu para n8n e que o Módulo 17 estabeleceu para assinatura. O padrão "autoridade central única, todo o resto consulta" já é familiar neste projeto — reduz risco de execução, porque não é padrão novo, é o mesmo padrão aplicado a mais um domínio.
