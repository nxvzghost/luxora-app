# PD-008 — Domínio Conversacional: Análise Arquitetural

> Nota de numeração (2026-07-18): este documento foi originalmente criado
> como PD-006. Renumerado para PD-008 para se alinhar à sequência oficial
> de Product Decisions da Luxora (PD-005 – Multi Unidade, PD-006 – IA
> Clínica, PD-007 – Identificação do Tenant via WhatsApp, PD-008 – Domínio
> Conversacional). Conteúdo inalterado, só a numeração e as referências
> cruzadas abaixo, atualizadas para os novos números.

## Pergunta única

**Qual é o domínio conversacional oficial da Luxora?**

Não discute WhatsApp, fila ou webhook — esses já foram tratados no PD-007
e no plano de validação do fluxo principal. Aqui a pergunta é de
modelagem: que conceitos, agregados e eventos deveriam existir para que
"conversa com um paciente" seja um domínio de verdade, não um efeito
colateral de outras partes do sistema. Nenhum código, migration, schema
ou entidade foi alterado.

## Método

Investiguei tudo que hoje toca comunicação/IA no código real — não a
documentação de intenção — para responder com evidência, não suposição.

---

## Arquivos analisados

`domain-services/ai/ai-provider.ts`, `infrastructure/ai/anthropic-ai.provider.ts`,
`use-cases/ai/processar-mensagem.use-case.ts`, `use-cases/ai/intent-action-router.ts`,
`use-cases/ai/system-prompt.builder.ts`, `use-cases/communication/enviar-mensagem.use-case.ts`,
`infrastructure/messaging/whatsapp-message.provider.ts`,
`infrastructure/messaging/{message-queue.producer,message-queue.worker}.ts`,
`domain-services/communication/{message-provider,message-log.repository}.ts`,
`schema.prisma` (`MessageLog`), `domain/patient/patient.entity.ts`,
`domain/appointment/appointment.entity.ts`, `domain-services/platform/audit.service.ts`,
e uma busca por `Notification`/`Conversation` em todo `src/`.

---

## Estado atual

### O achado central: não existe domínio conversacional hoje

Busquei `Conversation` em todo `src/` — **zero ocorrências como entidade
de domínio.** O que existe com esse nome são apenas formatos de dados de
passagem (`ConversationMessage`, `ConversationInput`, `ConversationContext`
em `ai-provider.ts`) — interfaces usadas para *chamar* o provider de IA,
nunca uma entidade persistida, sem identidade própria, sem ciclo de vida,
sem Repository. Busquei também `Notification` — **zero ocorrências em
todo o sistema.**

### O que existe hoje, e por que não é um domínio

1. **`ProcessarMensagemUseCase`** exige `conversationHistory:
   ConversationMessage[]` como entrada — mas nada no sistema hoje
   constrói esse array a partir de dado real. É um parâmetro que o
   chamador precisa montar na mão, toda vez, porque não há onde esse
   histórico "morar" entre chamadas.
2. **`MessageLog`** (`schema.prisma`) — `toPhoneNumber`, `body`,
   `idempotencyKey`, `providerMessageId`, `status` ('sent'|'failed').
   **100% de saída.** Sem `direction`, sem `fromPhoneNumber`, sem vínculo
   com `patientId`, sem agrupamento por conversa. Não é um histórico de
   conversa — é um log de envio, para idempotência de mensagens
   automáticas (cobrança, lembrete), nada mais.
3. **`AiInteractionAuditEvent`** — definido *dentro* de
   `processar-mensagem.use-case.ts`, estende `DomainEvent`, mas **não
   pertence a nenhuma entidade de domínio.** Isso é uma inconsistência
   real com o resto do sistema: em todo outro lugar (Patient, Therapist,
   Appointment, Billing, `ClinicSubscription`, `RecurringBlock`), quem
   emite `DomainEvent` é a própria Entidade/Aggregate Root, via
   `pullDomainEvents()` — nunca um Use Case fabricando o evento
   diretamente. Aqui, por não existir nenhuma entidade "Conversa", o
   evento nasce solto dentro do Use Case, quebrando o padrão que o resto
   da base já segue rigorosamente.
4. **Bug latente confirmado pela ausência do domínio:** `RNF-021` define
   o teto de custo como **"por conversa"** (`COST_CEILING_PER_CONVERSATION_BRL
   = 0.25`), mas `checkCostCeiling()` recebe só o custo do **turno atual**
   — nunca soma turnos anteriores da mesma conversa, porque não existe
   nenhuma entidade que acumule isso. Uma conversa real de 10 mensagens
   pode ultrapassar R$ 0,25 no total sem que o alerta dispare uma única
   vez, porque cada chamada individual, isolada, fica sempre abaixo do
   teto. Isso não é uma suposição — é uma consequência direta e
   verificável da falta de um Aggregate que represente a conversa inteira.
5. **`IntentResult.requiresEscalation`/`escalationReason`** já existem e
   já são respeitados por `IntentActionRouter` (nunca age quando
   `requiresEscalation=true`) — mas não há nenhum destino para esse sinal.
   Nenhuma entidade registra "esta conversa está esperando um humano",
   nenhum operador é notificado, nenhum estado muda. O conceito de
   escalonamento já existe na interpretação da IA, mas não tem onde
   pousar depois de detectado.

### Responsabilidades hoje

| Responsabilidade | Onde vive | Está correto? |
|---|---|---|
| Interpretar intenção da mensagem | `AnthropicAIProvider` (via porta `IAIProvider`) | Sim — porta bem desenhada, IA nunca é chamada direto por Use Case |
| Rotear intenção para ação real | `IntentActionRouter` | Sim — delega para os Use Cases de cada domínio (Agenda, Billing), nunca acessa entidade de outro domínio diretamente |
| Enviar mensagem de saída | `EnviarMensagemUseCase` + `WhatsAppMessageProvider` | Sim, para o que se propõe (envio simples) |
| Guardar o que foi dito, por quem, quando | **Ninguém** | Não — é o vazio central desta análise |
| Saber se uma conversa está ativa, escalada ou encerrada | **Ninguém** | Não existe |
| Acumular custo de IA por conversa real (não por turno) | **Ninguém** | Não existe — bug latente confirmado acima |

---

## Modelagem do domínio

### O que é uma `Conversation`

Aggregate Root: representa uma interação contínua entre um remetente
(paciente identificado ou não — ver abaixo) e uma clínica (Tenant), num
canal específico, com estado próprio (ativa, escalada, encerrada) e dona
do histórico ordenado de `Message`s. É o lugar natural para acumular
custo de IA real por conversa, decidir quando encerrar, e registrar
escalonamento como fato de domínio, não como booleano perdido.

### O que é uma `Message`

Entidade dentro do Aggregate `Conversation` — nunca uma Aggregate Root
própria, porque uma mensagem isolada, fora do contexto da conversa em que
aconteceu, não tem significado de negócio autônomo (o mesmo raciocínio já
aplicado a `BillingSession` dentro de `Billing`, por exemplo).

### Os conceitos pedidos, um a um

- **Direção:** campo de primeira classe da `Message` (entrada = do
  paciente para a clínica; saída = da clínica/IA para o paciente) — hoje
  inexistente em qualquer lugar (nem `MessageLog` modela isso, porque só
  cobre saída).
- **Status:** ciclo de vida da entrega de uma `Message` dentro do canal
  (enviada, entregue, lida, falhou) — hoje só "sent"/"failed" existe
  (`MessageLog.status`), sem "entregue"/"lida".
- **Entrega/Leitura:** dependem de eventos que o próprio canal informa
  depois do envio (a Meta manda webhook de status separado do de
  mensagem) — hoje não há nenhum tratamento disso; é natural que
  atualize o `status` de uma `Message` já existente, não que crie um
  registro novo.
- **Contexto:** hoje é um array solto (`ConversationMessage[]`) que o
  chamador monta na mão a cada chamada — no domínio correto, é
  simplesmente o histórico de `Message`s já pertencentes à própria
  `Conversation`, sem precisar ser reconstruído por fora.
- **Histórico:** a sequência ordenada de `Message`s da `Conversation` —
  hoje inexistente como estado persistido (nada grava mensagem de
  entrada).
- **Participante:** quem está "na" conversa do lado do paciente — hoje o
  sistema já antecipa isso corretamente ao tratar `patientId` como
  **opcional** em `ConversationInput`/`IntentActionRouter` (um número de
  WhatsApp pode escrever antes de virar `Patient` cadastrado — ex:
  primeiro contato de alguém buscando terapia). O domínio de Conversa
  precisa suportar isso nativamente: uma conversa pode começar sem
  `patientId` e ganhar um depois (quando/se a pessoa virar paciente),
  nunca o contrário.
- **Operador humano vs. IA:** hoje só existe a distinção binária
  `requiresEscalation`, sem nenhum "quem está respondendo agora" como
  estado. O domínio precisa de um conceito de **autor de cada `Message`
  de saída** (IA, ou um `User`/`Therapist` humano específico) — hoje
  `MessageLog` não registra autor nenhum, mesmo para as mensagens que já
  são enviadas de fato (cobrança, lembrete).

---

## Responsabilidades — separação clara

| Camada | O que pertence aqui |
|---|---|
| **Domínio** (novo Bounded Context "Comunicação"/"Atendimento") | `Conversation` (raiz), `Message` (entidade filha), regras de quando escalar/encerrar, acúmulo de custo real por conversa |
| **Infraestrutura** | `ConversationRepository` (persistência), nada de regra de negócio |
| **Integração** | Webhook/Controller que traduz payload externo em comando ao domínio (ex: "registrar mensagem recebida") — desenhado no PD-007/plano de validação, não aqui |
| **IA** | `IAIProvider` — continua uma porta consultada pelo domínio, nunca dona do estado da conversa (já está correto hoje, deve continuar assim) |
| **Canais de comunicação** | `MessageProvider`/`WhatsAppMessageProvider` — adapters de envio, sem regra de negócio, só tradução de protocolo |

**Achado de acoplamento a corrigir na modelagem (não implementar agora):**
`EnviarMensagemUseCase`/`MessageProvider` usam `toPhoneNumber` como nome
de campo — um acoplamento direto a canais baseados em telefone. Isso
importa para "Casos futuros" (abaixo): um domínio de Conversa bem
desenhado não deveria assumir telefone como o único tipo de endereço de
destinatário.

---

## Agregados

- **`Conversation`** — Aggregate Root do domínio conversacional.
- **`Message`** — Entidade, pertence exclusivamente a uma `Conversation`.
- **Não pertencem a este domínio** (já modelados corretamente em outros lugares, só referenciados por id):
  - `Patient` — dono da identidade da pessoa; `Conversation` referencia `patientId` (opcional), nunca duplica dado de paciente.
  - `Appointment`/`Billing` — ações que uma `Conversation` pode *disparar* via `IntentActionRouter`, nunca dados que a `Conversation` possui.
  - `WhatsAppIntegration` — pertence ao domínio de canal/credencial (Tenant), não ao domínio de conversa; `Conversation` só precisa saber qual canal ela usa, não como autenticar nele.

---

## Eventos do domínio (modelagem, não implementação)

- `ConversaIniciada` — primeira mensagem de um remetente novo, ou reabertura após encerramento/inatividade.
- `MensagemRecebida` — cada mensagem de entrada.
- `MensagemEnviada` — cada mensagem de saída (IA ou humano).
- `RespostaDeIAGerada` — especialização de `MensagemEnviada` quando o autor é a IA; substituiria o atual `AiInteractionAuditEvent`, hoje solto no Use Case, por um evento emitido pela própria `Conversation`.
- `ConversaEscalonadaParaHumano` — quando `requiresEscalation=true` deixa de ser um booleano perdido e vira um fato registrado, com motivo.
- `ConversaEncerrada` — fechamento explícito ou por política (não decidida aqui — ver Casos futuros).

Todos seguiriam o mesmo padrão já usado em todo o resto do sistema:
emitidos pela entidade, coletados via `pullDomainEvents()`, persistidos
pelo `AuditService` já existente — nenhum mecanismo novo de auditoria
seria necessário.

---

## Casos futuros — a arquitetura recomendada suporta, sem decidir agora

- **Voz:** se `Message.content` for modelado como algo que pode representar texto ou uma referência a mídia (não necessariamente uma nova classe agora), a `Conversation` não precisa mudar — só o que preenche `content`. Hoje `MessageLog.body` é `String` puro, uma suposição de texto que precisaria ser revisitada, mas não é um bloqueio estrutural.
- **E-mail:** aqui está o acoplamento real a corrigir na modelagem (não na implementação): `toPhoneNumber` deveria virar algo como um endereço de destinatário genérico por canal, para não impedir e-mail sem redesenho. Verificado, não implementado.
- **Portal do paciente / aplicativo:** são canais **autenticados e síncronos**, diferente de um webhook anônimo — o domínio de `Conversation` não deveria se importar com *como* a mensagem chegou (webhook vs ação autenticada no portal), só que ela pertence a uma `Conversation` de um `channel` específico. Suportado, se `Conversation` não amarrar sua identidade a "veio de webhook".
- **Múltiplos canais simultâneos:** uma pessoa pode escrever via WhatsApp e depois usar o portal — é uma decisão em aberto **de propósito**: uma `Conversation` por canal (mais simples, recomendado por ora) ou uma `Conversation` que atravessa canais (mais rico, mais complexo, sem necessidade comprovada hoje). Não decidido aqui.

Nenhum desses canais é implementado nesta análise — só confirmado que a
modelagem recomendada não fecha a porta para eles.

---

## Alternativas de modelagem

### Alternativa A — `Conversation` como Aggregate Root, `Message` como Entidade filha, Bounded Context próprio

- **Vantagens:** mesma disciplina DDD já usada em 100% do resto do sistema (Patient, Appointment, Billing, `RecurringBlock` são todos Aggregate Roots ricos com `pullDomainEvents()`); resolve de vez a inconsistência do `AiInteractionAuditEvent` hoje solto; corrige o bug latente de custo por conversa (soma real de turnos, não turno isolado); dá lugar de primeira classe para escalonamento, status de entrega/leitura, histórico.
- **Desvantagens:** mais um Bounded Context para manter; exige decidir fronteira de transação (mensagem por mensagem vs. conversa inteira) — decisão técnica, não bloqueante, para quando for desenhar a persistência.
- **Complexidade:** média.
- **Escalabilidade:** alta — é o padrão que já escala bem em todo o resto da base.

### Alternativa B — Sem Aggregate `Conversation`: `Message` plana, "conversa" é só uma query

- **Vantagens:** menos conceito novo, implementação inicial mais rápida.
- **Desvantagens:** perde a capacidade de modelar estado da conversa (ativa? escalada? encerrada?) como fato de domínio — cada pergunta vira lógica de consulta espalhada; eventos como `ConversaIniciada`/`ConversaEncerrada` não têm onde morar; o bug de custo por conversa **continua sem solução**, porque não há entidade para acumular.
- **Complexidade:** baixa.
- **Escalabilidade:** média — funciona hoje, degrada em regras de negócio à medida que crescem.

### Alternativa C — Domínio multi-canal abstrato desde já (preparado para voz/e-mail/portal simultaneamente no desenho inicial)

- **Vantagens:** nenhum retrabalho futuro teórico.
- **Desvantagens:** viola YAGNI diretamente — só WhatsApp é prioridade hoje (PD-001); abstrair para canais que não existem ainda é exatamente o tipo de complexidade antecipada que esta sessão tem rejeitado consistentemente (Account/PD-005, API pública/PD-004).
- **Complexidade:** alta, sem necessidade comprovada.
- **Descartada** pelo mesmo princípio já aplicado a todas as decisões anteriores.

---

## Recomendação oficial

**Alternativa A, com o mesmo cuidado de escopo já aplicado no resto da
sessão:** `Conversation`/`Message` como domínio real, mas desenhado para
**um canal por vez** (hoje só WhatsApp) — sem abstração multi-canal
antecipada (isso descartaria a C), e sem abrir mão do domínio como
entidade de primeira classe (isso descartaria a B, que deixaria um bug de
custo já identificado sem solução estrutural).

**Por que deve virar o padrão oficial:** é a única alternativa que
corrige, ao mesmo tempo, uma inconsistência arquitetural já confirmada
(`AiInteractionAuditEvent` fora do padrão do resto do sistema) e um bug
de negócio já confirmado (teto de custo por conversa nunca acumula) —
sem introduzir nenhuma abstração que a Luxora ainda não precisa.

---

## Impacto, se aprovada

- **Módulos que mudarão:** Módulo 11 (Comunicação) ganha um Bounded Context real; Módulo 12 (IA) passa a ser consumido pelo domínio de Conversa (a porta `IAIProvider` não muda, quem a chama muda); `ProcessarMensagemUseCase`/`IntentActionRouter` passam a operar sobre uma `Conversation` carregada do repositório, não sobre um array montado à mão.
- **Documentos que dependerão desta decisão:** `docs/05-IA/00-Provedor-e-Interface.md` (hoje só descreve o provider, não o domínio que o consome); `docs/03-Database` (o Bounded Context precisará de tabelas, em uma etapa própria de aprovação); `docs/10-Sprint-0/08-Plano-de-Validacao-do-Fluxo-Principal.md` (a Fase C, hoje só "decisão de schema", ganha uma resposta de modelagem concreta).
- **PDs impactados:** PD-007 (a `Conversation` é quem vai consumir o `tenantId` resolvido ali); o desenho técnico do webhook (próxima etapa natural) passa a ter uma entidade concreta para escrever, em vez de uma decisão de schema solta; PD-003/PD-004 (API pública, congelada) — se um dia descongelar, "conversas"/"mensagens" vira um candidato de endpoint muito mais sólido com este domínio pronto do que seria hoje.

---

## Relatório executivo

1. **Arquivos analisados:** listados no topo do documento — toda a cadeia de IA/comunicação hoje existente, mais busca exaustiva por `Conversation`/`Notification` em todo `src/`.
2. **Evidências:** zero entidade de domínio `Conversation` hoje; `MessageLog` é 100% outbound, sem direção/participante/agrupamento; `AiInteractionAuditEvent` foge do padrão de todo o resto do sistema (evento emitido por Use Case, não por Entidade); bug latente confirmado — teto de custo "por conversa" (RNF-021) nunca acumula de verdade, porque não existe entidade para somar; `patientId` já opcional em toda a cadeia de IA, confirmando que o domínio já antecipa conversas sem paciente identificado.
3. **Alternativas avaliadas:** `Conversation` como Aggregate Root rico (recomendada); `Message` plana sem agregado (mais simples, mas deixa o bug de custo sem solução); domínio multi-canal abstrato desde já (descartada por violar YAGNI, mesmo princípio já usado em todas as decisões anteriores).
4. **Recomendação:** Alternativa A, escopada a um canal por vez — `Conversation`/`Message` como domínio de primeira classe, seguindo exatamente a mesma disciplina DDD já usada por Patient/Appointment/Billing/RecurringBlock.
5. **Trade-offs:** mais um Bounded Context para manter, em troca de corrigir uma inconsistência arquitetural e um bug de negócio já confirmados — não é complexidade nova por preferência, é complexidade que corrige o que já está quebrado.
6. **Riscos:** nenhum risco novo introduzido pela modelagem em si; o risco real é de escopo — desenhar o Bounded Context maior do que o necessário para o canal único de hoje (mitigado explicitamente na recomendação, que rejeita a abstração multi-canal antecipada).
7. **Próximos passos:** com esta decisão aprovada, os próximos documentos naturais seriam (cada um como sua própria etapa de aprovação, sem código ainda): (a) o desenho técnico do agregado `Conversation`/`Message` (atributos, invariantes, máquina de estados); (b) só depois disso, o desenho do webhook do PD-007 passa a ter uma entidade concreta para escrever, em vez de uma decisão de persistência solta.
