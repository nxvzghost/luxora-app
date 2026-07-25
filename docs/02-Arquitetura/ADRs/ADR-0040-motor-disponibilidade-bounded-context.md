# ADR-0040 — Motor de Disponibilidade como Bounded Context central, obrigatório para todo módulo (derivado de PD-001)

**Status:** Aprovada como decisão de arquitetura — **Fase 1 (Módulo 18 — Centralização) implementada**. Fases 2-4 (Módulos 19-21) continuam não iniciadas, cada uma aguardando aprovação própria de escopo — ver `docs/11-Product-Decisions/PD-001-Motor-de-Disponibilidade/05-Plano-de-Implementacao.md`.
**Origem:** PD-001 — Motor de Disponibilidade Inteligente (ver `docs/11-Product-Decisions/PD-001-Motor-de-Disponibilidade/`)
**Data:** Julho de 2026

**Nota sobre a numeração:** este repositório só tinha ADR-0001 a ADR-0021 versionadas em `docs/02-Arquitetura/ADRs/` até este ponto — ADR-0022 a ADR-0039 são referenciadas em comentários de código já existentes (ex: ADR-0037, ADR-0039, ambas do Módulo 17 — Assinatura/Asaas) mas nunca tiveram arquivo próprio trazido para este repositório. ADR-0040 preserva o número original do documento recebido, sem tentar preencher essa lacuna retroativamente — registrado aqui para quem notar o salto.

## Contexto

PD-001 estabelece que toda decisão de disponibilidade deve passar por um componente central ("o Motor decide"), e que nenhum módulo pode acessar a agenda diretamente. Análise do código real confirmou que essa regra já é violada hoje por 4 Casos de Uso (ver `02-Analise-Arquitetural.md` da pasta do PD).

## Decisão

1. **Novo Bounded Context de Domínio**: `Availability`, com `AvailabilityCalendar` como Aggregate Root (1 por Terapeuta), substituindo `Therapist.availability`.
2. `ScheduleSlot` (Value Object já existente desde o Módulo 02) migra para este contexto — é reaproveitado, não recriado.
3. Único método de decisão real: `AvailabilityCalendar.isAvailable(from, to, bookedSlots): boolean` — toda pergunta "esse horário está livre?" passa por aqui. `VerificarDisponibilidadeUseCase` (`use-cases/availability/`) é a fachada de aplicação que carrega o `AvailabilityCalendar`, junta os Appointments ativos do período e chama este método — nenhum outro Caso de Uso monta essa checagem por conta própria.
4. `AgendarConsultaUseCase`, `RemarcarConsultaUseCase`, `CriarAgendamentoRecorrenteUseCase` e `IntentActionRouter` (Módulo 12) passam a consultar o Motor antes de agir — correção de 4 violações já confirmadas no código atual. **Implementado:** as 3 primeiras chamam `VerificarDisponibilidadeUseCase` diretamente (recusando com erro estruturado `SLOT_NOT_AVAILABLE` quando o horário não está livre); `IntentActionRouter` nunca precisou de nenhuma mudança própria — herda a proteção por construção, porque chama `AgendarConsultaUseCase` por baixo.
5. Importação de agenda externa (Google/Apple/Outlook/ICS/CSV/Excel) é Infrastructure, não Domain — modelada como `CalendarImportProvider` (porta), mesmo padrão de `PaymentProvider`/`MessageProvider`/`IAIProvider`.

## Alternativas consideradas

**Manter disponibilidade dentro de `Therapist`, só adicionar validação nos Use Cases de Agenda.** Rejeitada — não resolve o problema de fundo (múltiplos módulos, incluindo IA e futura importação externa, precisariam duplicar acesso a um dado que mora dentro de outra entidade). Também não atende ao pedido explícito do PD-001 de avaliar Bounded Context novo.

## Consequências

- `Therapist` perde o campo `availability` — mudança de contrato que precisou de migration cuidadosa: dado real existente (seed de desenvolvimento) foi migrado via `INSERT ... SELECT` a partir do JSON antigo antes do `DROP COLUMN` (ver `apps/backend/prisma/migrations/20260717033632_add_availability_calendar/`), não uma reescrita silenciosa.
- `IntentActionRouter` (Módulo 12) **não precisou de correção própria** — a violação era estrutural em `AgendarConsultaUseCase`, não no roteador em si; corrigir a origem bastou.
- Trabalho grande o bastante para ser tratado como programa de módulos (18-21 propostos), não um módulo único — ver `Product-Decisions/PD-001-Motor-de-Disponibilidade/05-Plano-de-Implementacao.md`.
- **Fase 1 (Módulo 18) implementada e testada**: novo Bounded Context em `domain/availability/`, `domain-services/availability/`, `use-cases/availability/`; tabela `availability_calendar` com RLS ativa; 302 testes unitários e 24 Testes Críticos (+1 skip documentado) passando. Fases 2-4 continuam não implementadas.
