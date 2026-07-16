# PD-001 — Análise Arquitetural

## Método

Antes de propor qualquer coisa nova, investiguei o código real (não a documentação — o código) pra saber exatamente onde a arquitetura atual diverge do que o PD-001 exige. Cada afirmação abaixo foi verificada por leitura direta do repositório, não por suposição.

## O que já existe (base real, não construída do zero)

### `ScheduleSlot` (Value Object) — `domain/schedule/schedule-slot.value-object.ts`
Já existe desde o Módulo 02, com máquina de estados própria (`Livre → Reservado → Confirmado`, `Livre → Bloqueado`, `Livre → Indisponivel`) e detecção de sobreposição (`overlapsWith`). **Isso já é, conceitualmente, a menor unidade do Motor de Disponibilidade** — só nunca foi tratado como autoridade central, foi tratado como detalhe de implementação de um Use Case.

### `ConsultarDisponibilidadeUseCase` — `use-cases/appointment/consultar-disponibilidade.use-case.ts`
Já combina corretamente 3 fontes: disponibilidade semanal do terapeuta + duração de sessão da clínica + agendamentos ativos existentes, gerando `ScheduleSlot`s livres. **Essa é, na prática, uma versão inicial do "consultar o Motor"** — só que só é chamada pela rota de consulta (`GET /therapists/:id/availability`), nunca pelo fluxo de criação de agendamento.

### `Therapist.availability: WeeklyAvailabilitySlot[]`
Modelo simples (dia da semana + horário início/fim), sem: intervalo de almoço, intervalo entre pacientes, exceções (férias/feriados/bloqueios), nem qualquer coisa além de um padrão semanal fixo.

## Violações reais encontradas (não hipotéticas — confirmadas no código)

### Violação 1 — CRÍTICA: `AgendarConsultaUseCase` nunca consulta o Motor

```
apps/backend/src/use-cases/appointment/agendar-consulta.use-case.ts
```

Este Use Case cria um `Appointment` e chama `repo.save()` diretamente. A única proteção contra conflito é uma constraint de unicidade parcial no banco (`unique-active-appointment.sql`, Módulo 07) — ou seja, **o sistema descobre o conflito só na hora de salvar, por erro de banco, não decide preventivamente consultando disponibilidade real**. Hoje é possível tentar agendar um horário fora da janela de expediente do terapeuta e o sistema só rejeitaria se colidisse com outro agendamento — fora isso, aceitaria.

### Violação 2 — CRÍTICA: `IntentActionRouter` (IA) chama `AgendarConsultaUseCase` direto

```
apps/backend/src/use-cases/ai/intent-action-router.ts
```

Implementado antes desta diretriz existir — a IA extrai `therapistId`/`scheduledAt` da conversa e chama `AgendarConsultaUseCase` diretamente. **Isso é exatamente "a IA decidindo horário sozinha"**, a violação nomeada explicitamente no PD-001, construída por mim mesmo. Precisa ser corrigida como parte da implementação — registrado sem disfarce.

### Violação 3 — `CriarAgendamentoRecorrenteUseCase` idem
Mesmo padrão: cria N `Appointment`s direto, sem consultar uma autoridade central.

### Violação 4 — `RemarcarConsultaUseCase` idem
Reagendar salva sem consultar se o novo horário está dentro da disponibilidade real.

## O que não existe (gap total, não parcial)

| Exigência do PD-001 | Estado atual |
|---|---|
| Exceções (férias, feriado, bloqueio, licença) | **Inexistente.** `WeeklyAvailabilitySlot` só modela padrão semanal fixo. |
| Intervalo de almoço / intervalo entre pacientes | **Inexistente.** Um bloco de disponibilidade é só início-fim. |
| Assistente de configuração via IA na implantação | **Inexistente.** Disponibilidade só é criada via `PUT /therapists/:id/availability`, chamada direta de API. |
| Pacientes recorrentes bloqueando agenda automaticamente | **Parcial.** `CriarAgendamentoRecorrenteUseCase` cria as ocorrências futuras como `Appointment`s reais — bloqueia a agenda na prática, mas não existe "padrão recorrente" como entidade própria. |
| Importação de agenda externa (Google/Apple/Outlook/ICS/CSV/Excel) | **Inexistente.** |
| Renovação automática vs. mediante confirmação | **Inexistente.** |
| Monitoramento proativo da IA sobre estado da agenda | **Inexistente.** O agente (Módulo 12) só responde, nunca inicia conversa proativamente. |

## Conclusão da análise

O PD-001 não pede pra "adicionar uma feature" — pede pra **promover uma lógica que já existe, mas está espalhada e opcional, para uma autoridade central e obrigatória**, e depois construir em cima dela um conjunto de capacidades novas e substanciais que hoje não existem de forma nenhuma.

São dois trabalhos de tamanho muito diferente:
1. **Centralização** (promover o que existe): esforço médio, mexe em código já escrito, risco de regressão real se malfeito.
2. **Capacidades novas** (importação externa, assistente de setup, monitoramento): esforço grande, praticamente todo código novo.

Ver `05-Plano-de-Implementacao.md` para a proposta de fasear essas duas frentes.
