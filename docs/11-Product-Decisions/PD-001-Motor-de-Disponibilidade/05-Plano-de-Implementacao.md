# PD-001 — Plano de Implementação (faseado, nada implementado ainda)

Numeração de módulo proposta: **Módulo 18 — Motor de Disponibilidade**, próximo da fila (17 já é Assinatura+Asaas).

## Por que fasear

O PD-001 descreve um sistema completo. Implementar tudo de uma vez tem alto risco de regressão (mexe em Agenda, IA e Terapeuta ao mesmo tempo) e mistura "correção de arquitetura" com "capacidade nova". Proponho 4 fases, cada uma entregável e testável isoladamente.

## Fase 1 — Centralização (corrige as violações já existentes)

**Objetivo:** nenhum módulo cria/altera agendamento sem consultar o Motor. Sem capacidade nova ainda, só reorganização + obrigatoriedade.

- Criar `domain/availability/` (Bounded Context, ver doc 04)
- Migrar `WeeklyAvailabilitySlot` de `Therapist` para `AvailabilityCalendar`
- `ConsultarDisponibilidadeUseCase` passa a ser implementado sobre `AvailabilityCalendar.isAvailable()`
- Corrigir `AgendarConsultaUseCase`, `RemarcarConsultaUseCase`, `CriarAgendamentoRecorrenteUseCase` para consultar o Motor antes de agir
- Corrigir `IntentActionRouter` (M12) — a IA passa a consultar disponibilidade antes de confirmar agendamento, nunca decide sozinha

**Critério de pronto:** teste automatizado prova que é impossível criar um `Appointment` fora da disponibilidade real sem passar pelo Motor — mesmo padrão de "teste de aceite" já usado no ADR-0021 (n8n) e no gate de acesso de assinatura (M17).

## Fase 2 — Exceções e recorrência como conceito próprio

**Objetivo:** férias, feriados, bloqueios, e pacientes recorrentes como entidades de domínio, não workarounds.

- `AvailabilityException` implementada e testada
- `RecurringBlock` implementado — `CriarAgendamentoRecorrenteUseCase` passa a criar um `RecurringBlock` e materializar ocorrências a partir dele
- Renovação automática vs. manual (`renewalMode`) — automação no mesmo padrão do Módulo 14

## Fase 3 — Assistente de configuração via IA

**Objetivo:** clínica nova é configurada por conversa, não por formulário.

- Novo fluxo conversacional (Módulo 12 + 11): sequência de perguntas guiada
- Cada resposta popula `AvailabilityCalendar` incrementalmente
- Identificação/cadastro de pacientes recorrentes via conversa, antes da clínica operar

## Fase 4 — Importação de agenda externa + monitoramento proativo

**Objetivo:** as duas capacidades de maior esforço de engenharia, e as menos urgentes pra operar uma clínica nova.

- `CalendarImportProvider` (porta) + implementações: Google Calendar primeiro, depois ICS, depois CSV/Excel
- Parser de recorrência a partir de dado importado (heurística sugere `RecurringBlock`, nunca cria automaticamente sem confirmação humana)
- Monitoramento proativo da IA — depende do Motor completo (Fases 1-3) para ter dado confiável de monitorar

## Ordem recomendada e por quê

Fase 1 antes de tudo — menor risco relativo, sem ela as fases seguintes construiriam sobre a violação central ainda presente. Fase 4 por último porque depende de Fase 1-3 sólidas e é o maior esforço de engenharia nova.

## Meta-dívida já registrada

Este PD-001 completo (as 4 fases) é maior que um módulo — é um programa de trabalho. Recomendo tratar a Fase 1 como o próximo módulo real (18), e as Fases 2-4 como módulos subsequentes (19, 20, 21), cada um com sua própria aprovação de escopo — nunca assumir que aprovar o PD-001 aprova as 4 fases de uma vez.
