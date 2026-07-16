# PD-001 — Bounded Context e Domínio

## Pergunta que o PD-001 faz explicitamente

"Atualize o domínio caso o Motor de Disponibilidade deva tornar-se um novo Bounded Context."

## Resposta: sim, deve.

## Por que — os 3 sinais que justificam isso, não é escolha estética

1. **Múltiplos contextos consomem, nenhum contexto deveria possuir.** O próprio PD-001 lista 9 consumidores (IA, Agenda, Agendamento, Reagendamento, Financeiro, Sessões, WhatsApp, Confirmações, Cobranças, Relatórios). Quando um conceito é consumido por quase todo o sistema mas hoje "mora" dentro de uma entidade específica (`Therapist`), isso é o sintoma clássico de Bounded Context mal-posicionado.

2. **Regras de negócio próprias, sem relação com Therapist como entidade.** "Nunca dois compromissos sobrepostos", "recorrência bloqueia automaticamente", "exceção sempre vence sobre padrão", "renovação automática vs. manual" — nenhuma dessas regras é sobre "quem é o terapeuta". Hoje estão espalhadas entre `Therapist`, `Appointment` e `ConsultarDisponibilidadeUseCase` porque não têm casa própria.

3. **Ciclo de vida e cadência de mudança diferentes.** `Therapist` muda raramente. Disponibilidade muda toda semana, tem exceções pontuais, tem importação de fonte externa.

## Proposta de modelagem

### Novo Bounded Context: `Availability` (Disponibilidade)

```
domain/availability/
├── availability-calendar.entity.ts      (Aggregate Root — 1 por Terapeuta)
├── availability-window.value-object.ts  (substitui WeeklyAvailabilitySlot — ganha almoço, intervalo entre pacientes)
├── availability-exception.entity.ts     (férias, feriado, bloqueio, licença)
├── recurring-block.entity.ts            (representa "paciente X toda terça 14h", não uma lista de Appointments)
└── schedule-slot.value-object.ts        (já existe — migra pra cá)
```

### `AvailabilityCalendar` — Aggregate Root proposto

Um por Terapeuta (`therapistId` como referência, nunca posse). Encapsula:
- `windows: AvailabilityWindow[]` — padrão semanal, com almoço e intervalo entre pacientes
- `exceptions: AvailabilityException[]` — datas específicas que sobrescrevem o padrão
- `recurringBlocks: RecurringBlock[]` — pacientes recorrentes, fonte de verdade separada dos `Appointment`s individuais
- `renewalMode: 'automatic' | 'manual'`

Método central, único ponto de decisão real:

```typescript
isAvailable(from: Date, to: Date): boolean
```

Esse método — não um Use Case por fora — é o que responde "esse horário está livre?". **Esse é literalmente "o Motor decide"**, expresso como método de domínio, não como orquestração externa.

### O que sai de `Therapist`

`availability: WeeklyAvailabilitySlot[]` é removido da entidade. `Therapist` passa a não saber nada sobre sua própria agenda.

### O que muda em `Appointment`

Nada na entidade em si. Muda quem a cria: `AgendarConsultaUseCase` passa a depender de `AvailabilityCalendar.isAvailable()` antes de instanciar um `Appointment` novo.

## O que NÃO deveria virar Bounded Context separado

**Importação de agenda externa (Google/Apple/Outlook/ICS/CSV/Excel)** — isso é Infrastructure, não Domain. Cada integração vira um `CalendarImportProvider` (porta) com implementações concretas — mesmo padrão de `PaymentProvider`/`MessageProvider`/`IAIProvider`. O resultado alimenta o `AvailabilityCalendar`, não é contexto à parte.

## Consequência para o Módulo 06 original

`DefinirDisponibilidadeUseCase`, hoje classificado como Caso de Uso de Terapeuta, é na verdade um Caso de Uso do contexto de Disponibilidade que só "empresta" o `therapistId`. Vale registrar isso no roadmap quando a implementação começar.
