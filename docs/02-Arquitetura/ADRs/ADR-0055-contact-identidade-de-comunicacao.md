# ADR-0055 — Contact: Identidade de Comunicação, Promoção e Desambiguação (AD-018)

**Status:** ADOTADA E IMPLEMENTADA — v2 congelada e aprovada; implementação concluída em 7 Fases sequenciais, cada uma revisada e aprovada individualmente; validada (build/lint/unit/integration/critical) e sincronizada Windows↔WSL em 31/07/2026. Hardening de produção (Fase 8.0/8.1/8.2 — concorrência, resiliência, observabilidade/correlationId) concluído e revalidado em 01/08/2026.
**Origem:** gap funcional real identificado na consolidação da documentação de Arquitetura de Domínio (Marco 1) — um Contact de WhatsApp que nunca conversou com a clínica antes não tem `patientId`, e sem `patientId` nenhum intent de agendamento executa. Contatos novos não conseguiam completar um agendamento pelo WhatsApp.
**Relacionada a:** ADR-0043 (Contact representa identidade de comunicação), ADR-0044 (Patient representa vínculo clínico), ADR-0045 (primeiro agendamento promove Contact para Patient), ADR-0046 (ambiguidades sempre resolvidas antes de executar), ADR-0053/ADR-0054 (canal WhatsApp e Inbox Pattern, ambos preservados intocados por esta AD).

## Problema

`Conversation.patientId` é resolvido uma única vez, no momento da criação da `Conversation`, via `PatientRepository.findByPhone()`. Se nenhum `Patient` já existir com aquele telefone, `patientId` fica `null` para sempre — `Conversation` não tem nenhum mecanismo para atualizá-lo depois. Como `IntentActionRouter.routeAgendarConsulta()` exige `context.patientId` (regra de segurança: nunca adivinha um ID), um contato genuinamente novo nunca conseguia agendar pelo WhatsApp — o próprio canal que a clínica mais usa para captar pacientes novos.

## Decisão

Implementar o Aggregate `Contact` — já modelado e congelado nos documentos de domínio (`08-Contact-e-Identidade-de-Comunicacao.md`, ADR-0043/0044/0045/0046) — como uma identidade de comunicação **distinta** de `Patient`, no mesmo Bounded Context, associada por uma tabela N:N explícita (`ContactPatientAssociation`, papel `proprio_paciente`/`responsavel_por`), nunca composição. `Contact` nunca é criado/mutado fora do próprio Aggregate; toda persistência passa por `ContactRepository`; toda orquestração de identidade (promoção/associação/desambiguação) passa por Use Cases dedicados e por um Router que nunca contém lógica de domínio.

## Escopo e restrições aprovadas

- **`Patient` permanece 100% intocado** — nenhuma migration, nenhum campo novo, nenhuma mudança de comportamento. `PatientState.Novo`/`Identificado` (nomes coincidentes com `ContactState`, tipos Postgres e TypeScript inteiramente distintos) não foram renomeados — decisão explícita de não misturar duas mudanças independentes na mesma AD.
- **`Conversation`/`Message` permanecem 100% intocados** — `Contact` é resolvido de forma independente, pelo mesmo número de telefone (string simples, nunca uma referência de domínio), nunca por FK ou composição.
- **Inbox Pattern (ADR-0054/AD-036) permanece 100% intocado** — nenhum arquivo relacionado a `InboxEntry`/`WhatsAppInboundQueueWorker` foi modificado em nenhuma das 7 Fases.
- **`ContactId`/`TenantId`/`PatientId` permanecem `string` puro** — divergência deliberada da v1 da arquitetura, aprovada explicitamente: nenhuma entidade do codebase encapsula IDs em Value Objects; criar essa exceção só para `Contact` introduziria um padrão novo e inconsistente.
- **Desambiguação nunca tem estado persistido próprio** — reconstruída a cada turno a partir do histórico de `Message` e do estado atual do `Contact`, nunca uma tabela ou máquina de estados nova para "pendência de confirmação".

## Arquitetura

### Domínio (Fase 2)

- `PhoneNumber` (Value Object) — normalização E.164 Brasil-only, nunca reaproveitado por `Conversation.phoneNumber` (que permanece `string` livre, decisão da AD-007, não revista aqui).
- `Contact` (Aggregate Root) — máquina de estados `Novo → Conversando → Identificado → {Vinculado, Promovido} → Arquivado → Descartado` (`Identificado` nunca transiciona para `Arquivado`, conforme o processo de retenção congelado em `13-Process-Managers.md`). Métodos: `create()`, `createAlreadyLinked()` (Cenário 14 — telefone já bate com Patient cadastrado pelo painel), `interagir()` (idempotente), `identificar(nome)`, `promoverParaPaciente()`, `vincularAPacienteExistente()`, `associarAPaciente()` (recebe as associações existentes por parâmetro do chamador, nunca as guarda — fora do limite de consistência do Aggregate), `arquivar()`, `anonimizar()` (LGPD).
- `ContactPatientAssociation` (Entity, nunca Aggregate própria) — vários por Contact (casal) e vários por Patient ao longo do tempo (troca de número) são o caso normal.
- 9 Domain Events, auditados via `AuditService` (Módulo 10) — nunca descartados.

### Persistência (Fase 1/3)

- Tabelas `contact`/`contact_patient_association`, RLS padrão, `contact.phone_number` nullable (achado real corrigido durante a Fase 2: `anonimizar()` exige telefone nulo, a migration original da Fase 1 deixava a coluna `NOT NULL` — migration aditiva corrigiu, sem tocar índices/FKs/RLS).
- `ContactRepository`/`PrismaContactRepository` — split `save()` (cabeçalho)/`saveAssociation()` (filho), mesmo padrão de `BillingRepository`/`ConversationRepository`. `saveAssociation()` tolerante a `P2002` (retry idempotente de reentrega).
- `ContactModule` — mesmo padrão de `InboxModule`: módulo dedicado, sem controller, evita redeclaração de providers entre consumidores (`AIModule`, `CommunicationModule`).

### Use Cases (Fase 4/6)

- `ReconhecerOuCriarContatoUseCase` — único ponto de entrada de reconhecimento/criação, chamado a cada mensagem de entrada (`ReceberMensagemWhatsAppUseCase`, síncrono) e re-chamado de forma idempotente dentro do worker assíncrono (`ProcessarMensagemWhatsAppUseCase`) para obter o `contactId`, sem tocar no payload do BullMQ.
- `ConsultarContatoUseCase` (leitura), `PromoverContatoUseCase` (orquestra `CadastrarPacienteUseCase`, existente e inalterado, + `Contact.promoverParaPaciente()`), `AssociarContatoUseCase` (`Contact.associarAPaciente()`).

### Integração com WhatsApp (Fase 5)

`ReceberMensagemWhatsAppUseCase` chama `ReconhecerOuCriarContatoUseCase` logo após o guard de idempotência — nunca conhece `ContactRepository`/`PhoneNumber` diretamente. `ProcessarMensagemWhatsAppUseCase` (worker) re-resolve o mesmo Contact via `conversation.phoneNumber` para obter `contactId` dentro do fluxo assíncrono.

### Roteamento de identidade e IA (Fase 6/7)

Eixo de classificação **separado** de `IntentActionRouter`/`IAIProvider.interpretIntent()` (que decide "o que o paciente quer fazer"): `ContactIntentClassifier` (porta) decide "o que fazer com o vínculo de identidade", devolvendo só um rótulo estruturado — `PROMOVER`/`ASSOCIAR`/`DESAMBIGUAR`/`IGNORAR`/`HUMANO`. A decisão final de agir pertence sempre a `ContactIntentActionRouter` (backend), nunca à IA.

`ContactIntentActionRouter` depende só de Use Cases e do classificador — nunca de Repository/Prisma, nunca cria um Aggregate manualmente. Toda validação de invariante (transição de estado, duplicidade de associação, qualificação do Contact) vive exclusivamente no Aggregate; o Router chama o Use Case e trata erros de domínio esperados (`DuplicateContactPatientAssociationError`) como sucesso idempotente, sem duplicar a condição localmente.

`ASSOCIAR` só age com um `patientId` já resolvido por fora (`Conversation.patientId`) — nunca descobre ou adivinha um paciente por nome (ADR-0046). Sem esse sinal, devolve `requiresConfirmation`.

`ProcessarMensagemUseCase` chama `ContactIntentActionRouter` (só quando `contactId` presente — retrocompatível) **antes** do `IntentActionRouter` existente, na mesma janela da mensagem: um `patientId` recém-resolvido pela promoção já habilita o agendamento pedido na mesma frase, fechando o gap original.

`AnthropicContactIntentClassifier` — implementação real, com timeout (8s, configurável) + retry (até 2 tentativas, só em falha de rede/timeout/5xx, nunca 4xx nem corpo malformado numa resposta 2xx — tratado como não-repetível), correlationId (header + logs, mesmo padrão de `WhatsAppMessageProvider`/`WhatsAppInboundQueueWorker`), `usage`/custo somado ao teto RNF-021 junto com `interpretIntent()` (que também passou a expor seu custo real, antes invisível) e `generateResponse()`.

## Impactos

- Fecha o gap funcional original: um Contact novo que se identifica e pede a primeira consulta é promovido a Patient e agendado na mesma mensagem.
- Custo real de IA por turno passa de até 2 chamadas para até 3 — mitigado pela soma completa contabilizada contra o teto RNF-021.
- `PatientsModule` ganhou seu primeiro `export` (`CadastrarPacienteUseCase`) — nenhum consumidor existente afetado.

## Hardening de Produção (Fase 8 — pós-implementação)

Com as 7 Fases funcionais já aprovadas e aguardando commit, o usuário autorizou uma fase adicional de hardening — sem nenhuma nova regra de negócio, sem tocar `Contact`/`Conversation`/`Patient` (Aggregates) nem esta ADR em nível de decisão arquitetural — cobrindo três subfases sequenciais, cada uma implementada, testada e aprovada individualmente:

- **Fase 8.0 — Concorrência:** `PrismaContactRepository.save()` não tratava `P2002` numa corrida real de duas mensagens simultâneas do mesmo número nunca visto antes (dois `ReconhecerOuCriarContatoUseCase` concorrentes, dois `randomUUID()` diferentes, ambos caindo no ramo `create()` do `upsert()`). Corrigido reaproveitando o mesmo idioma já usado em `saveAssociation()` — swallow de `P2002` como no-op idempotente, comprovado seguro porque os dois lados da corrida sempre computam a mesma transição de estado (`Novo→Conversando`). Provado contra Postgres real com um teste de `Promise.all()` genuíno.
- **Fase 8.1 — Resiliência:** `AnthropicAIProvider` (`interpretIntent()`/`generateResponse()`) ganhou o mesmo padrão de resiliência já validado em `AnthropicContactIntentClassifier` — timeout via `AbortController` (`AI_PROVIDER_TIMEOUT_MS`, default 8s), retry (até 2 tentativas, só em timeout/falha de rede/5xx, nunca 4xx nem corpo malformado numa resposta 2xx), preservando `usage`/custo/auditoria/correlationId e compatibilidade total com os consumidores existentes.
- **Fase 8.2 — Observabilidade:** `MetricsService` novo (`src/shared/`) — em memória, sem dependência externa, sem Prometheus/OpenTelemetry/dashboard (fora de escopo desta subfase) — instrumentando chamadas/duração/erros/retries/timeouts/custo em `AnthropicAIProvider`, `AnthropicContactIntentClassifier`, `ContactIntentActionRouter`, `ProcessarMensagemUseCase` e `ProcessarMensagemWhatsAppUseCase`. `correlationId` passou a ser propagado ponta a ponta (Webhook → Queue → Worker → `ProcessarMensagemWhatsAppUseCase` → `ProcessarMensagemUseCase` → `AnthropicAIProvider` → `AnthropicContactIntentClassifier`) via extensão aditiva (`correlationId?: string`) nos contratos já existentes — **achado real corrigido nesta subfase:** o campo já existia em `WhatsAppInboundJobData` desde a AD-016, mas nunca era preenchido de fato (`ReceberMensagemWhatsAppUseCase` nunca o passava ao enfileirar, e `WhatsAppInboundQueueWorker` resolvia um valor local mas chamava `execute(job.data)` sem repassá-lo) — ambos os pontos corrigidos, provado ponta a ponta contra Postgres/Redis/BullMQ reais por um teste crítico novo que verifica que o mesmo `X-Correlation-Id` enviado no header do webhook chega às 3 chamadas de IA do turno.

## Testes

Cobertura completa em cada Fase: domínio (Aggregate, VO, máquina de estados, eventos), integração real contra Postgres (round-trip, RLS cruzando Tenants), Use Cases (unitário, com fakes), Router (promoção, associação, desambiguação, nenhum match, múltiplos matches, caminhos negativos, idempotência), classificador (retry, timeout, erros, usage). Suíte crítica (`whatsapp-inbound-idempotency.test.ts`) validada de ponta a ponta com o pipeline de 3 chamadas de IA, provando que o Inbox Pattern (AD-036) permanece intacto.

**Resultado final (7 Fases + hardening Fase 8.0/8.1/8.2):** build/lint limpos; unit 649/649; integration 9/9; critical 184/184 (1 skip pré-existente).

## Divergências da v1 original (aprovadas)

1. `ContactId`/`TenantId`/`PatientId` como `string`, não Value Objects (ver "Escopo e restrições").
2. Resolução da colisão de nomenclatura `ContactState`/`PatientState` (AD-024) removida do escopo — tipos e enums Postgres sempre foram estruturalmente distintos, a coincidência é só cosmética.

## Rollback

Reverter código das 7 Fases — `Patient`/`Conversation`/`Message`/Inbox Pattern nunca foram tocados, sem risco de inconsistência cruzada. Rollback de schema (se necessário): novas migrations corretivas (`DROP TABLE contact_patient_association`, `DROP TABLE contact`, `DROP TYPE`), nunca editar as já aplicadas.

## Documentos Relacionados

- `docs/PLANO_DE_EXECUCAO.md` — Epic 9, AD-018.
- ADR-0043, ADR-0044, ADR-0045, ADR-0046 — arquitetura de domínio congelada que esta AD implementa.
- ADR-0053, ADR-0054 — canal WhatsApp e Inbox Pattern, ambos preservados intocados.

## Histórico

- **v1** — arquitetura completa proposta (Aggregate, VOs incluindo `ContactId`/`TenantId`/`PatientId`, resolução de AD-024 via enum surgery). Revisão do usuário pediu duas mudanças antes da aprovação.
- **v2** — resolução de AD-024 removida do escopo (mantém `Patient` 100% intocado); seção dedicada de desambiguação detalhada (10 sub-tópicos). **Aprovada.**
- **Fase 1** (schema/migration/RLS) — aprovada.
- **Fase 2** (domínio) — aprovada; achado real corrigido antes da conclusão (`phone_number` nullable) via migration aditiva aprovada separadamente; divergência dos VOs de ID formalmente aprovada nesta fase.
- **Fase 3** (infraestrutura) — aprovada; achado real de escopo de módulo Nest (`ContactModule` precisa importar `AuditModule` diretamente, não basta o consumidor importar os dois lado a lado) corrigido e documentado.
- **Fase 4** (Use Cases) — escopo confirmado como só `ReconhecerOuCriarContatoUseCase`; aprovada.
- **Fase 5** (integração com `ReceberMensagemWhatsAppUseCase`) — aprovada; 2 critical tests corrigidos (cleanup de `contact`/`contact_patient_association` antes do cleanup do Tenant).
- **Fase 6** (Router + prompt de IA) — construída isolada do pipeline ao vivo, por decisão explícita do usuário (custo real de uma segunda chamada de IA por turno); aprovada com melhoria opcional sugerida (extrair prompt/parser).
- **Fase 7** (integração ao vivo + observabilidade + custo + regressão) — melhoria opcional da Fase 6 aplicada antes da integração; pipeline completo conectado; revisão técnica final encontrou e corrigiu 2 inconsistências reais (corpo malformado numa resposta 2xx tratado como repetível; duplicação literal da regra de dedupe do Aggregate em `ContactIntentActionRouter.handleAssociar()`) — ambas corrigidas, suíte revalidada 100% verde. **Aprovada para commit em 31/07/2026.**
- **Fase 8.0** (hardening — concorrência) — corrigida a corrida de criação concorrente de `Contact` em `PrismaContactRepository.save()`; provada contra Postgres real. Achado do "Domain Event órfão do lado perdedor da corrida" registrado como pendência técnica conhecida, deliberadamente não corrigida nesta subfase. **Aprovada.**
- **Fase 8.1** (hardening — resiliência) — `AnthropicAIProvider` ganhou timeout/retry/AbortController no mesmo padrão de `AnthropicContactIntentClassifier`. Decisão de não implementar `correlationId` nesta subfase (mudança de contrato público, fora do escopo definido) tomada e confirmada correta. **Aprovada.**
- **Fase 8.2** (hardening — observabilidade) — `MetricsService` novo instrumentando os 5 componentes do pipeline de IA/Contact; `correlationId` propagado ponta a ponta pela primeira vez de fato (achado real: existia desde a AD-016 mas nunca era preenchido) — 2 pontos corrigidos (`ReceberMensagemWhatsAppUseCase`, `WhatsAppInboundQueueWorker`), provados por teste crítico novo. Suíte completa revalidada: unit 649/649, integration 9/9, critical 184/184 (1 skip pré-existente). **Aprovada para commit em 01/08/2026.**

## Considerações Finais

Sete fases sequenciais, cada uma com escopo explícito, revisão e aprovação próprias, sem nenhum desvio silencioso: todo achado real (nullable de schema, escopo de módulo Nest, duplicação de regra de domínio no Router) foi documentado e corrigido no momento em que foi descoberto, nunca deixado para depois. `Patient`, `Conversation`/`Message` e o Inbox Pattern (AD-036) — as três áreas mais sensíveis do sistema por já estarem em produção — permanecem, ao final de toda a implementação, exatamente como estavam antes desta AD começar.
