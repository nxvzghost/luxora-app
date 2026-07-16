# ADR-0040 — Motor de Disponibilidade como Bounded Context central, obrigatório para todo módulo (derivado de PD-001)

**Status:** Aprovada como decisão de arquitetura — **implementação NÃO iniciada**, aguardando aprovação de escopo.
**Origem:** PD-001 — Motor de Disponibilidade Inteligente (ver `docs/11-Product-Decisions/PD-001-Motor-de-Disponibilidade/`)
**Data:** Julho de 2026

**Nota sobre a numeração:** este repositório só tinha ADR-0001 a ADR-0021 versionadas em `docs/02-Arquitetura/ADRs/` até este ponto — ADR-0022 a ADR-0039 são referenciadas em comentários de código já existentes (ex: ADR-0037, ADR-0039, ambas do Módulo 17 — Assinatura/Asaas) mas nunca tiveram arquivo próprio trazido para este repositório. ADR-0040 preserva o número original do documento recebido, sem tentar preencher essa lacuna retroativamente — registrado aqui para quem notar o salto.

## Contexto

PD-001 estabelece que toda decisão de disponibilidade deve passar por um componente central ("o Motor decide"), e que nenhum módulo pode acessar a agenda diretamente. Análise do código real confirmou que essa regra já é violada hoje por 4 Casos de Uso (ver `02-Analise-Arquitetural.md` da pasta do PD).

## Decisão

1. **Novo Bounded Context de Domínio**: `Availability`, com `AvailabilityCalendar` como Aggregate Root (1 por Terapeuta), substituindo `Therapist.availability`.
2. `ScheduleSlot` (Value Object já existente desde o Módulo 02) migra para este contexto — é reaproveitado, não recriado.
3. Único método de decisão real: `AvailabilityCalendar.isAvailable(from, to): boolean` — toda pergunta "esse horário está livre?" passa por aqui.
4. `AgendarConsultaUseCase`, `RemarcarConsultaUseCase`, `CriarAgendamentoRecorrenteUseCase` e `IntentActionRouter` (Módulo 12) passam a consultar o Motor antes de agir — correção de 4 violações já confirmadas no código atual.
5. Importação de agenda externa (Google/Apple/Outlook/ICS/CSV/Excel) é Infrastructure, não Domain — modelada como `CalendarImportProvider` (porta), mesmo padrão de `PaymentProvider`/`MessageProvider`/`IAIProvider`.

## Alternativas consideradas

**Manter disponibilidade dentro de `Therapist`, só adicionar validação nos Use Cases de Agenda.** Rejeitada — não resolve o problema de fundo (múltiplos módulos, incluindo IA e futura importação externa, precisariam duplicar acesso a um dado que mora dentro de outra entidade). Também não atende ao pedido explícito do PD-001 de avaliar Bounded Context novo.

## Consequências

- `Therapist` perde o campo `availability` — mudança de contrato que precisa de migration cuidadosa se já existir dado real.
- `IntentActionRouter` (Módulo 12) precisa de correção — hoje viola a regra central deste próprio ADR, construído antes dele existir.
- Trabalho grande o bastante para ser tratado como programa de módulos (18-21 propostos), não um módulo único — ver `Product-Decisions/PD-001-Motor-de-Disponibilidade/05-Plano-de-Implementacao.md`.
- Nenhum código escrito ainda — este ADR registra a decisão de arquitetura para quando a implementação for aprovada.
