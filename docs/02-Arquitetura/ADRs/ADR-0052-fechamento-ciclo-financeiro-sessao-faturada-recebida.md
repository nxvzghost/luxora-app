# ADR-0052 — Fechamento do Ciclo Financeiro: gatilhos de `Session.Faturada`/`Recebida`

**Status:** ADOTADO — decisão de produto aprovada em 28/07/2026. Implementação da AD-009 autorizada sob os termos exatos desta ADR (ver "Histórico").
**Origem:** AD-009 (`docs/PLANO_DE_EXECUCAO.md`, Epic 6 — Fechamento do Ciclo Financeiro), fase de descoberta solicitada explicitamente antes de qualquer implementação.
**Data:** 28 de julho de 2026

## Objetivo

Definir, com precisão executável, o gatilho exato que faz uma `Session` transicionar de `Realizada` para `Faturada` e de `Faturada` para `Recebida` — a decisão de produto que `PLANO_DE_EXECUCAO.md` já registrava como pendente desde a criação do item de backlog ("exige decisão de produto sobre o exato gatilho de `Faturada`... confirmar antes de implementar, não assumir").

## Contexto (confirmado por leitura direta do código-fonte, não por inferência)

**`Session` já tem a máquina de estados completa e correta, só não é usada:**

```ts
// apps/backend/src/domain/session/session.entity.ts
export type SessionState = 'Realizada' | 'Faturada' | 'Recebida';

const sessionTransitions: Record<SessionState, readonly SessionState[]> = {
  Realizada: ['Faturada'],
  Faturada: ['Recebida'],
  Recebida: [], // estado terminal
};
```

Confirmado por busca exaustiva em todo `src/`: **nenhum Use Case, em nenhum arquivo, jamais chama `session.transitionTo(...)`.** O único ponto de mutação de `Session` em produção é `Session.createFromConfirmedAppointment()` (sempre estado inicial `'Realizada'`, disparado por `ConfirmarConsultaUseCase`). `Faturada`/`Recebida` são código morto — exatamente o achado já registrado em `docs/AUDITORIA_TECNICA_DEFINITIVA.md`, seção 3.4.

**`Billing` e `Payment` já têm suas próprias máquinas de estado funcionando, de ponta a ponta, sem nunca tocar `Session`:**

```ts
// apps/backend/src/domain/billing/billing.entity.ts
export type BillingState = 'Criada' | 'Enviada' | 'Visualizada' | 'Pendente'
  | 'Atrasada' | 'Negociada' | 'Escalada' | 'Quitada' | 'Cancelada';

const billingTransitions: Record<BillingState, readonly BillingState[]> = {
  Criada: ['Enviada', 'Quitada', 'Cancelada'], // Quitada direto de Criada é intencional — ver achado abaixo
  Enviada: ['Visualizada', 'Pendente', 'Cancelada'],
  Visualizada: ['Pendente', 'Quitada', 'Cancelada'],
  Pendente: ['Quitada', 'Atrasada', 'Cancelada'],
  Atrasada: ['Negociada', 'Escalada', 'Quitada'],
  Negociada: ['Pendente', 'Quitada'],
  Escalada: ['Negociada', 'Quitada'],
  Quitada: [],    // estado terminal
  Cancelada: [],  // estado terminal
};
```

```ts
// apps/backend/src/domain/payment/payment.entity.ts
export type PaymentState = 'Recebido' | 'EmConferencia' | 'Confirmado' | 'Divergente' | 'Estornado';
```

**Fluxo real hoje, lido linha a linha nos Use Cases:**

- `GerarCobrancaUseCase` (`use-cases/billing/billing.use-cases.ts`) — cria a `Billing` (`Billing.create()`, estado inicial sempre `'Criada'`), salva, e chama `billingRepo.linkSessions(billing.id, input.sessionIds)`, que grava a linha em `billing_session` (`UNIQUE(session_id)` — uma Sessão nunca em 2 cobranças abertas ao mesmo tempo). **Não injeta `SessionRepository`. Nenhuma Sessão muda de estado aqui.**
- `EnviarCobrancaUseCase` — transiciona `Billing` `Criada → Enviada`, enfileira a mensagem real ao paciente. **Também não injeta `SessionRepository`.**
- `RegistrarPagamentoUseCase` (`use-cases/payment/payment.use-cases.ts`) — cria o `Payment`, chama `payment.reconcile(billing.amount)` (`Confirmado` se bater o valor, `Divergente` se não); **só quando `payment.state === 'Confirmado'`**, transiciona `billing.transitionTo('Quitada')`. **Também não injeta `SessionRepository`.**
- `EstornarPagamentoUseCase` — transiciona `Payment` `Confirmado → Estornado`. Não toca `Billing` nem `Session` (ver "Riscos", acha­do sobre reversão).

**Achado de modelagem relevante para o gatilho:** `Billing` não tem um campo `sessionIds` — o vínculo é só via tabela de junção `billing_session` (N:N, migração já existente). O `BillingRepository` hoje só expõe `linkSessions()` (escreve) e `countLinkedSessions()` (conta) — **não existe nenhum método para ler de volta os `sessionId`s vinculados a uma `Billing`.** Qualquer implementação desta ADR vai precisar de um método novo no repositório (ex.: `findSessionIdsByBillingId(billingId)`), lendo `billing_session`. Isso é uma constatação técnica, não uma decisão de produto — registrado aqui para que a futura fase de implementação não seja pega de surpresa.

## Problema

Sem o vínculo `Billing`/`Payment` → `Session`, o estado de uma `Session` no banco nunca reflete a realidade financeira — uma sessão cobrada e paga continua eternamente com `state: 'Realizada'`. Isso já é sabido (é o próprio objetivo do Epic 6). O que falta decidir é **exatamente em qual evento de aplicação** cada transição deve disparar, porque mais de um ponto do código *poderia* ser escolhido, e a escolha errada quebra invariantes que já existem hoje.

## Decisão proposta

### 1. Evento exato que cria uma `Billing`

`GerarCobrancaUseCase.execute()` — o único ponto de criação de `Billing` em todo o código-base (`Billing.create()` + `repo.save()` + `repo.linkSessions()`). Não há ambiguidade aqui — é o único candidato existente.

### 2. Gatilho exato de `Session → Faturada`

**Proposta: no mesmo `GerarCobrancaUseCase.execute()`, imediatamente após `linkSessions()`** — cada `Session` referenciada em `input.sessionIds` transiciona `Realizada → Faturada` na mesma execução que cria a `Billing`, nunca em `EnviarCobrancaUseCase` (envio da mensagem).

**Por que não em `EnviarCobrancaUseCase` (a alternativa óbvia, e a que o próprio risco registrado em `PLANO_DE_EXECUCAO.md` cogita): isto está tecnicamente bloqueado pela própria máquina de estados de `Billing`, não é só uma questão de estilo.** O comentário já existente em `billing.entity.ts` documenta que `Criada → Quitada` é uma transição **intencional**: "um pagamento pode ser registrado antes de qualquer envio de cobrança (ex: paciente paga em mãos/PIX direto no consultório)". E `RegistrarPagamentoUseCase` exige `billing.id` (via `billingId` no `Payment`) — **um `Payment` só pode existir depois que a `Billing` já foi criada**, então o caminho "paga na hora, nunca chega a ser enviada" já é suportado e provavelmente comum (cobrança avulsa por sessão, paga no consultório). Se `Faturada` só disparasse em `EnviarCobrancaUseCase`, esse caminho pularia `Faturada` inteiramente — e a própria máquina de estados de `Session` **rejeita esse pulo** (`Realizada: ['Faturada']` — não existe `Realizada → Recebida` direto; o teste de unidade já existente, `session.entity.test.ts`, já cobre exatamente essa rejeição). Ou seja: **dispar Faturada só no envio quebraria, de forma comprovável, o caminho de pagamento imediato que já existe em produção hoje** — não é uma preferência arquitetural, é uma incompatibilidade concreta com uma transição que a própria entidade `Billing` já declara como válida.

### 3. Estados permitidos da máquina de estados

**Nenhuma mudança na máquina de estados de `Session`.** `Realizada → Faturada → Recebida`, com `Recebida` terminal, já está correta e já é testada (`session.entity.test.ts`, "percorre o fluxo até Recebida"). Esta ADR é sobre **conectar** Use Cases já existentes a uma máquina de estados já correta — não sobre alterar a máquina em si. Nenhuma migration necessária (nenhuma coluna nova; `Session.state` já existe e já é persistida).

### 4. Gatilho exato de `Session → Recebida`

**Proposta: em `RegistrarPagamentoUseCase.execute()`, exatamente no mesmo bloco condicional que já transiciona `billing.transitionTo('Quitada')`** (`if (payment.state === 'Confirmado')`) — todas as `Session`s vinculadas àquela `Billing` (via `billing_session`) transicionam `Faturada → Recebida` no mesmo momento, nunca antes. Se o pagamento for `Divergente`, nem `Billing` nem `Session` mudam de estado — comportamento que já existe hoje para `Billing` e se estende naturalmente para `Session`.

**Implicação de modelagem, não de decisão:** como uma `Billing` agrega N `Session`s (semanal/mensal) e o pagamento é reconciliado contra o valor total da `Billing` (não por sessão individual), a baixa é **tudo-ou-nada** — todas as sessões vinculadas àquela cobrança recebem `Recebida` juntas, atomicamente com a `Billing`. Não existe (nem esta ADR propõe criar) o conceito de pagamento parcial de uma sessão dentro de uma cobrança agregada — consistente com o modelo já existente.

## Impacto na Arquitetura

- **`GerarCobrancaUseCase` passa a injetar `SessionRepository`** — hoje não injeta. Precisa carregar cada `Session` de `input.sessionIds`, chamar `transitionTo('Faturada')`, salvar, e mesclar os eventos de todas as Sessions ao `recordAll()` já existente da `Billing` — mesmo padrão já usado em `ConfirmarConsultaUseCase` (único precedente hoje de mesclar eventos de duas entidades num único `recordAll([...a, ...b])`).
- **`RegistrarPagamentoUseCase` passa a injetar `SessionRepository`** e precisa de um novo método de leitura no `BillingRepository` (`findSessionIdsByBillingId` ou equivalente) para descobrir quais `Session`s pertencem à `Billing` sendo quitada — método que não existe hoje (só `linkSessions`/`countLinkedSessions`).
- **Nenhuma migration.** `Session.state` já é uma coluna persistida; a mudança é inteiramente de aplicação (Use Case), não de schema.
- **Nenhuma mudança de contrato de API** — `POST /billings` e `POST /payments` continuam com o mesmo formato de entrada/saída; o efeito colateral em `Session` é interno, não exposto (a menos que uma AD futura decida expor `session.state` numa resposta, fora de escopo aqui).

## Benefícios

- Fecha o gap central do Epic 6: o estado de `Session` no banco passa a refletir a realidade financeira, sem depender de inferência externa (junção manual com `billing_session`/`Payment` para saber se uma sessão já foi paga).
- Reaproveita 100% da máquina de estados, dos eventos de domínio (`SessionStateChangedEvent` já existe e já é auditável) e do padrão de auditoria já estabelecido — nenhum conceito novo introduzido na arquitetura.
- Gatilho escolhido é o único compatível com um caminho de pagamento que **já está em produção** (pagar sem nunca enviar a cobrança) — evita implementar algo que quebraria silenciosamente esse caso no primeiro teste crítico real (o mesmo tipo de achado que a própria `billing.entity.ts` já documenta ter acontecido uma vez: "descoberto ao rodar o Teste Crítico #8... pela primeira vez").

## Riscos

- **Fluxos de cancelamento e reversão ficam deliberadamente FORA do escopo desta ADR — e isso não é uma lacuna nova introduzida aqui, é uma lacuna pré-existente que esta ADR não piora nem resolve:**
  - `Billing.transitionTo('Cancelada')` já existe na máquina de estados, mas **nenhum `CancelarCobrancaUseCase` existe hoje** — é código morto, exatamente como `Faturada`/`Recebida` de `Session` eram antes desta proposta. Não há hoje nenhum caminho de aplicação que cancele uma `Billing`.
  - `EstornarPagamentoUseCase` transiciona `Payment` para `Estornado`, mas **não reverte `Billing` de `Quitada`** (a máquina de estados de `Billing` nem permite — `Quitada: []`, terminal). Ou seja, mesmo hoje, sem esta ADR, um estorno já deixa a `Billing` "presa" em `Quitada`.
  - Dado que nem `Billing` nem `Payment` têm um caminho de reversão funcional hoje, **`Session` também não deve ganhar um caminho de reversão nesta ADR** (`Recebida` permanece terminal, sem transição de volta) — implementar reversão só em `Session` criaria uma inconsistência nova (a Session "sabe" que foi estornada, mas a Billing/Payment que a originou não refletem isso). **Recomendação: registrar cancelamento/reversão financeira como um item de backlog separado e futuro** (afeta `Billing`+`Payment`+`Session` juntos, é maior que o escopo do AD-009), não tentar resolver parcialmente aqui.
  - **Edge case adjacente, também pré-existente e fora de escopo:** `Appointment` permite `Confirmada → Cancelada` mesmo depois que uma `Session` já foi criada a partir dele (`CancelarConsultaUseCase` não verifica se já existe uma `Session` vinculada). Hoje isso já deixa uma `Session` "órfã" (em `Realizada`, dona de um `Appointment` agora cancelado) sem nenhuma reação. Esta ADR não piora isso — mas também não resolve.
- **Impacto em auditoria:** sem risco novo — segue o padrão já estabelecido (`recordAll()` por entidade mutada, eventos mesclados quando duas entidades mudam na mesma operação, precedente já existente em `ConfirmarConsultaUseCase`).
- **Impacto em notificações futuras (Epic 12):** nenhum evento novo precisa ser criado — `SessionStateChangedEvent` já existe (`SessaoEstadoAlterado`) e simplesmente passa a ser emitido de verdade quando esta ADR for implementada. Quando o Epic 12 (AD-021) escolher seu canal de notificação, `Faturada`/`Recebida` já estarão disponíveis como gatilho sem trabalho adicional de instrumentação — `PLANO_DE_EXECUCAO.md` já identifica "eventos financeiros" como o gatilho mais óbvio para Epic 12; esta ADR é o que torna esses eventos reais.
- **Compatibilidade com Epic 8 (WhatsApp — reagendamento):** `remarcar_consulta` opera sobre `Appointment` (estados `Reservada`/`Confirmada`/`ReagendamentoSolicitado`/`Reagendada`), nunca sobre `Session` — uma `Session` só existe depois que o `Appointment` já foi `Confirmada` e o atendimento ocorreu. Não há sobreposição de estados entre o que esta ADR muda e o que Epic 8 precisa — compatível, sem ajuste necessário.
- **Compatibilidade com Epic 10 (frontend — AD-020, ações de mutação Financeiro):** o frontend consumirá exatamente os mesmos `POST /billings`/`POST /payments` já existentes; o efeito em `Session` é interno. Se o frontend quiser exibir `session.state` na tela, isso é uma decisão de DTO da própria AD-020/implementação futura, não desta ADR.
- **Compatibilidade com Epic 11 (Dashboard):** os indicadores hoje documentados (`docs/06-UX/02-Fluxo-Dashboard.md`) já são baseados em estado de `Billing` (ex.: "em atraso" = `Billing.Atrasada`), não em estado de `Session` — nenhuma consulta existente muda de comportamento.

## Evolução Futura

- Cancelamento/reversão financeira (`Billing.Cancelada`, reversão de `Session` após estorno) como AD própria, depois que esta ADR estiver implementada e estável — não antes, para não acoplar duas decisões de produto numa única mudança.
- Exposição de `session.state` em DTOs de resposta (Billing/Payment/Dashboard), se e quando o frontend (Epic 10/11) precisar dele — decisão de escopo daquela AD, não desta.

## Alternativas consideradas

| Alternativa | Gatilho de `Faturada` | Veredito |
|---|---|---|
| **A — proposta** | `GerarCobrancaUseCase` (criação da `Billing`) | **Recomendada** — único ponto compatível com o caminho de pagamento imediato já suportado por `Billing.Criada → Quitada` |
| B | `EnviarCobrancaUseCase` (`Billing.Enviada`) | Rejeitada — tecnicamente incompatível: uma `Billing` paga sem nunca ser enviada pularia `Faturada`, o que a máquina de estados de `Session` já rejeita hoje (testado) |
| C | Evento assíncrono/job separado, fora da transação do Use Case | Rejeitada sem necessidade de aprofundar — nenhum precedente no código-base usa esse padrão para transições de estado ligadas a uma ação HTTP direta; todos os outros exemplos (`ConfirmarConsultaUseCase`, `RegistrarPagamentoUseCase` quitando `Billing`) fazem a transição síncrona, na mesma requisição, e esta ADR segue o padrão já estabelecido |

## Documentos Relacionados

- `docs/PLANO_DE_EXECUCAO.md` — Epic 6, AD-009 (origem desta ADR).
- `docs/AUDITORIA_TECNICA_DEFINITIVA.md`, seção 3.4 — achado original do código morto de `Session.Faturada`/`Recebida`.
- `docs/01-Domain/03-Maquina-de-Estados.md.txt`, `docs/01-Domain/05-Linguagem-Ubiqua.md` — estados oficiais de `Session`/`Appointment` e a resolução Sessão vs. Agendamento.
- `docs/02-Arquitetura/ADRs/ADR-0017.md` — State Machine, princípio geral de auditoria de transições, referenciado por esta ADR.
- `docs/06-UX/04-Fluxo-Financeiro.md` — pipeline financeiro (`Billing`/`Payment`), que esta ADR estende para incluir `Session` explicitamente pela primeira vez.

## Histórico

- **28/07/2026** — Documento criado como fase de descoberta da AD-009, a pedido explícito, antes de qualquer implementação. Aguardando aprovação da decisão de produto (gatilho de `Faturada`, seção "Decisão proposta").
- **28/07/2026** — **Aprovado integralmente.** Decisão oficial confirmada nos termos exatos da seção "Decisão proposta" (Alternativa A): `Faturada` dispara dentro de `GerarCobrancaUseCase`, logo após `linkSessions()`; `EnviarCobrancaUseCase` não altera `Session`; máquina de estados inalterada; nenhuma migration; `SessionStateChangedEvent` e o padrão `recordAll()` de auditoria mantidos sem alteração. Escopo explicitamente EXCLUÍDO desta aprovação: cancelamento de `Billing`, estorno financeiro, reversão de `Session`, novos estados, e qualquer alteração de domínio além do mínimo para ativar a transição já existente. Único requisito adicional aprovado: método mínimo no `BillingRepository` para recuperar `sessionId`s vinculados a uma `Billing` (sem expandir responsabilidades além disso). Implementação da AD-009 autorizada a partir desta aprovação.

## Considerações Finais

O achado central desta descoberta é que a escolha do gatilho de `Faturada` **não é uma preferência de estilo entre duas opções igualmente válidas** — uma das duas alternativas óbvias (disparar no envio da cobrança) já está tecnicamente incompatível com um comportamento que o próprio `Billing` já suporta em produção (pagamento antes do envio). Isso reduz a decisão de produto pendente a, na prática, confirmar a única alternativa tecnicamente viável (Alternativa A) — mas a aprovação explícita continua sendo necessária antes de qualquer linha de código, por definição desta fase.
