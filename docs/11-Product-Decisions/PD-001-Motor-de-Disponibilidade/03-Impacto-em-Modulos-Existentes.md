# PD-001 — Impacto em Módulos Já Implementados

Cada módulo abaixo foi checado individualmente contra o código real. Só listo o que de fato muda.

## Módulo 02 — Domain Core
**Impacto: alto.** `ScheduleSlot` (Value Object) precisa ser promovido — deixa de ser um detalhe interno de `ConsultarDisponibilidadeUseCase` para ser a unidade fundamental de um Bounded Context novo (ver `04-Bounded-Context-e-Dominio.md`). Não é reescrita — é relocação e ampliação (precisa passar a suportar exceções, não só o estado atual de 5 valores).

## Módulo 06 — Clínica/Terapeuta
**Impacto: alto, estrutural.** `Therapist.availability: WeeklyAvailabilitySlot[]` sai da entidade `Therapist` e passa a ser responsabilidade do novo Bounded Context de Disponibilidade — `Therapist` passa a referenciar por `therapistId`, não a possuir o dado diretamente. Isso é uma mudança de dono do dado, não só de local do arquivo. `DefinirDisponibilidadeUseCase` (Módulo 06) muda de dono: hoje vive em `use-cases/therapist/`, deveria migrar para `use-cases/availability/` quando o novo contexto existir.

## Módulo 07 — Agenda
**Impacto: o maior de todos.** É o módulo mais diretamente confrontado pelo PD-001:
- `AgendarConsultaUseCase` precisa passar a consultar o Motor antes de criar o `Appointment` — hoje não consulta nada, só tenta salvar.
- `RemarcarConsultaUseCase` idem.
- `CriarAgendamentoRecorrenteUseCase` precisa consultar o Motor a cada ocorrência gerada, e idealmente vira consumidor de um conceito de "padrão recorrente" que passa a existir no Motor, não mais uma lista de `Appointment`s individuais criados de uma vez.
- `ConsultarDisponibilidadeUseCase` é o candidato natural a se tornar (ou ser absorvido por) a fachada pública do Motor — é o Use Case que mais se aproxima do papel exigido hoje.

## Módulo 09 — Financeiro
**Impacto: baixo, mas real.** Hoje `GerarCobrancaUseCase` não tem nenhuma lógica de horário — o impacto é indireto: cobrança depende de sessão realizada, sessão depende de agendamento confirmado, agendamento passa a depender do Motor. Nenhuma mudança direta de código, mas a cadeia de causalidade passa pelo Motor.

## Módulo 11 — Comunicação (WhatsApp)
**Impacto: baixo direto, mas é o canal do assistente de configuração.** O "assistente inteligente de configuração" conversacional na implantação usa a mesma infraestrutura já construída (`MessageQueueProducer`, `WhatsAppMessageProvider`), mas é um fluxo de conversa novo.

## Módulo 12 — IA
**Impacto: alto, e é onde a violação mais séria já existe.** `IntentActionRouter.routeAgendarConsulta()` precisa parar de chamar `AgendarConsultaUseCase` diretamente com um horário "adivinhado" das entidades extraídas — passa a consultar o Motor primeiro, e só confirma o agendamento se o Motor validar. O critério de autonomia da IA ganha uma regra nova: "a IA nunca decide horário sozinha, só o Motor decide" — deveria entrar em `system-prompt.builder.ts` como reforço explícito, não só regra de código.

Monitoramento proativo (agenda cheia/vazia) é capacidade nova neste módulo — hoje o agente é 100% reativo.

## Módulo 14 — Automações (n8n)
**Impacto: médio.** A "renovação automática da agenda" é, por natureza, uma automação agendada — mesmo padrão arquitetural já usado para a régua de inadimplência e o resumo diário (`AutomationsController`, gatilho externo via n8n, Motor decide o conteúdo).

## Módulo 17 — Assinatura (Asaas)
**Impacto: nenhum.** Sem relação com disponibilidade.

## Módulos sem impacto
01 (Fundação), 03 (Autenticação), 04 (Multi-Tenant), 05 (Pacientes, exceto vínculo indireto), 10 (Auditoria — mecanismo já existe e já suportaria os novos eventos sem mudança), 15 (Frontend, impacto é de tela nova, não de arquitetura), 16 (nunca implementado).

## Endpoints de API que mudam de contrato (Módulo 08)

- `GET /therapists/:id/availability` — hoje é a única porta de entrada da disponibilidade; passa a ser (ou ser substituída por) a fachada do Motor, possivelmente em um novo path `/availability/...`.
- `POST /appointments` — passa a validar contra o Motor antes de aceitar, podendo retornar um novo código de erro estruturado (ex: `SLOT_NOT_AVAILABLE`, distinto do atual `SESSION_CONFLICT`).
